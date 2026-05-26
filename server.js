import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createRequire } from 'module'
import { createWorker } from 'tesseract.js'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import crypto from 'crypto'

const require = createRequire(import.meta.url)
const pdf2picMod = require('pdf2pic')
const fromBuffer = pdf2picMod.fromBuffer

const app = express()
const PORT = process.env.PORT || 3000

const OCR_AUTH_TOKEN = process.env.OCR_AUTH_TOKEN
if (!OCR_AUTH_TOKEN) {
  console.error('FATAL: OCR_AUTH_TOKEN env var is required')
  process.exit(1)
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-OCR-Token'],
}))

app.use(express.json({ limit: '100mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

function requireAuth(req, res, next) {
  const token = req.headers['x-ocr-token'] || (req.headers['authorization'] || '').replace('Bearer ', '')
  if (token !== OCR_AUTH_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

app.get('/', (req, res) => {
  res.json({
    service: 'opsrunner-ocr-backend',
    status: 'running',
    version: '0.1.0',
  })
})

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

// ============================================================
// POST /ocr-pdf — Accept PDF buffer, return OCR'd text per page
// ============================================================
app.post('/ocr-pdf', requireAuth, upload.single('file'), async (req, res) => {
  const startTime = Date.now()
  let tempDir = null
  let worker = null

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' })
    }
    if (!req.file.mimetype.includes('pdf')) {
      return res.status(400).json({ success: false, error: 'File must be a PDF' })
    }

    console.log(`OCR job started: ${req.file.originalname} (${req.file.size} bytes)`)

    const maxPages = parseInt(req.body.max_pages || '20', 10)
    const dpi = parseInt(req.body.dpi || '200', 10)
    const lang = req.body.lang || 'eng'

    // Create temp directory for image conversion
    const jobId = crypto.randomBytes(8).toString('hex')
    tempDir = join(tmpdir(), `ocr-${jobId}`)
    await fs.mkdir(tempDir, { recursive: true })

    // Convert PDF to images (one per page)
    const convertOptions = {
      density: dpi,
      saveFilename: 'page',
      savePath: tempDir,
      format: 'png',
      width: 1700,
      height: 2200,
    }

    const convert = fromBuffer(req.file.buffer, convertOptions)
    console.log(`Converting PDF to images at ${dpi} DPI...`)

    const conversionResult = await convert.bulk(-1, { responseType: 'image' })
    const totalPages = conversionResult.length
    const pagesToProcess = Math.min(totalPages, maxPages)

    console.log(`PDF has ${totalPages} pages. Processing first ${pagesToProcess}.`)

    // Initialize Tesseract
    worker = await createWorker(lang)

    const pageResults = []
    for (let i = 0; i < pagesToProcess; i++) {
      const imgPath = conversionResult[i].path
      const pageStart = Date.now()
      const { data } = await worker.recognize(imgPath)
      const pageDuration = Date.now() - pageStart

      pageResults.push({
        page: i + 1,
        text: data.text,
        confidence: data.confidence,
        wordCount: data.text.split(/\s+/).filter(w => w.length > 0).length,
        durationMs: pageDuration,
      })

      console.log(`Page ${i + 1}/${pagesToProcess} OCR'd in ${pageDuration}ms (confidence: ${data.confidence.toFixed(1)}%)`)

      // Cleanup the image
      try { await fs.unlink(imgPath) } catch {}
    }

    await worker.terminate()
    worker = null

    const totalText = pageResults.map(p => p.text).join('\n\n')
    const avgConfidence = pageResults.reduce((s, p) => s + p.confidence, 0) / pageResults.length
    const totalWords = pageResults.reduce((s, p) => s + p.wordCount, 0)
    const totalDuration = Date.now() - startTime

    const response = {
      success: true,
      result: {
        filename: req.file.originalname,
        totalPages,
        pagesProcessed: pagesToProcess,
        pagesSkipped: Math.max(0, totalPages - pagesToProcess),
        text: totalText,
        avgConfidence: Math.round(avgConfidence * 10) / 10,
        totalWords,
        durationMs: totalDuration,
        pages: pageResults.map(p => ({
          page: p.page,
          confidence: Math.round(p.confidence * 10) / 10,
          wordCount: p.wordCount,
        })),
      },
    }

    console.log(`OCR job completed in ${totalDuration}ms. ${totalWords} words extracted.`)
    res.json(response)
  } catch (err) {
    console.error('OCR error:', err)
    res.status(500).json({
      success: false,
      error: err.message || 'OCR processing failed',
    })
  } finally {
    if (worker) {
      try { await worker.terminate() } catch {}
    }
    if (tempDir) {
      try {
        const files = await fs.readdir(tempDir)
        for (const f of files) {
          try { await fs.unlink(join(tempDir, f)) } catch {}
        }
        await fs.rmdir(tempDir)
      } catch {}
    }
  }
})

// ============================================================
// POST /ocr-image — Accept image, return OCR'd text
// ============================================================
app.post('/ocr-image', requireAuth, upload.single('file'), async (req, res) => {
  const startTime = Date.now()
  let worker = null

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' })
    }
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, error: 'File must be an image' })
    }

    console.log(`Image OCR started: ${req.file.originalname}`)

    const lang = req.body.lang || 'eng'
    worker = await createWorker(lang)
    const { data } = await worker.recognize(req.file.buffer)
    await worker.terminate()
    worker = null

    const wordCount = data.text.split(/\s+/).filter(w => w.length > 0).length
    const duration = Date.now() - startTime

    res.json({
      success: true,
      result: {
        filename: req.file.originalname,
        text: data.text,
        confidence: Math.round(data.confidence * 10) / 10,
        wordCount,
        durationMs: duration,
      },
    })

    console.log(`Image OCR completed in ${duration}ms. ${wordCount} words.`)
  } catch (err) {
    console.error('Image OCR error:', err)
    res.status(500).json({ success: false, error: err.message || 'OCR failed' })
  } finally {
    if (worker) {
      try { await worker.terminate() } catch {}
    }
  }
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' })
})

app.listen(PORT, () => {
  console.log(`OCR backend listening on port ${PORT}`)
})
