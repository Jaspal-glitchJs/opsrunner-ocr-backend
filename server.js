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
const { fromBuffer } = require('pdf2pic')

const app = express()
const PORT = process.env.PORT || 3000

// Authentication: backend rejects requests without this shared secret
const OCR_AUTH_TOKEN = process.env.OCR_AUTH_TOKEN
if (!OCR_AUTH_TOKEN) {
  console.error('FATAL: OCR_AUTH_TOKEN env var is required')
  process.exit(1)
}

// CORS — allow Supabase edge functions (and your Netlify frontend for direct testing)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-OCR-Token'],
}))

app.use(express.json({ limit: '100mb' }))

// File upload: max 50MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileS
