import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { sanitizeFileName, sha256, sha256Hex, sniffMimeType } from './sniff.ts'

describe('MIME sniffing and SHA-256 digest', () => {
  it('correctly calculates SHA-256 binary and hex', () => {
    let data = Buffer.from('Hello MMS Object Storage', 'utf8')
    let hash = sha256(data)
    let hex = sha256Hex(data)

    assert.equal(hash.length, 32)
    assert.equal(hex.length, 64)
    assert.equal(hex, hash.toString('hex'))
  })

  it('sniffs PDF from magic bytes', () => {
    let pdfBytes = Buffer.from('%PDF-1.7\n%test content\n%%EOF')
    let res = sniffMimeType(pdfBytes, 'unnamed.bin')

    assert.equal(res.mimeType, 'application/pdf')
    assert.equal(res.isKnown, true)
  })

  it('sniffs PNG image from magic bytes', () => {
    let pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    let res = sniffMimeType(pngBytes, 'photo.dat')

    assert.equal(res.mimeType, 'image/png')
    assert.equal(res.isKnown, true)
  })

  it('sniffs JPEG image from magic bytes', () => {
    let jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    let res = sniffMimeType(jpgBytes, 'image.bin')

    assert.equal(res.mimeType, 'image/jpeg')
    assert.equal(res.isKnown, true)
  })

  it('sniffs GIF image from magic bytes', () => {
    let gifBytes = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')
    let res = sniffMimeType(gifBytes)

    assert.equal(res.mimeType, 'image/gif')
    assert.equal(res.isKnown, true)
  })

  it('sniffs ZIP and OpenXML DOCX / XLSX from magic bytes', () => {
    let zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    let docxRes = sniffMimeType(zipHeader, 'spec.docx')
    assert.equal(
      docxRes.mimeType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )

    let xlsxRes = sniffMimeType(zipHeader, 'data.xlsx')
    assert.equal(
      xlsxRes.mimeType,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )

    let genericZip = sniffMimeType(zipHeader, 'archive.zip')
    assert.equal(genericZip.mimeType, 'application/zip')
  })

  it('sniffs plain text and CSV', () => {
    let csvData = Buffer.from('id,name,role\n1,alice,admin\n2,bob,user\n')
    let csvRes = sniffMimeType(csvData, 'export.csv')
    assert.equal(csvRes.mimeType, 'text/csv')

    let txtData = Buffer.from('Plain ASCII text file contents without formatting.\n')
    let txtRes = sniffMimeType(txtData, 'notes.txt')
    assert.equal(txtRes.mimeType, 'text/plain')
  })

  it('detects spoofed files pretending to be PDF', () => {
    let fakePdf = Buffer.from('<script>alert("evil")</script>')
    let res = sniffMimeType(fakePdf, 'dangerous.pdf')
    // Should NOT be sniffed as application/pdf!
    assert.notEqual(res.mimeType, 'application/pdf')
    assert.equal(res.isKnown, false)
  })

  it('handles empty and unknown binary buffer', () => {
    let empty = Buffer.alloc(0)
    assert.equal(sniffMimeType(empty).mimeType, 'application/octet-stream')

    let randomBin = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
    assert.equal(sniffMimeType(randomBin).mimeType, 'application/octet-stream')
  })

  it('sniffs legacy Office OLE2 documents (.doc, .xls, .ppt)', () => {
    let oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    let docRes = sniffMimeType(oleHeader, 'report.doc')
    assert.equal(docRes.mimeType, 'application/msword')
    assert.equal(docRes.isKnown, true)

    let xlsRes = sniffMimeType(oleHeader, 'calculation.xls')
    assert.equal(xlsRes.mimeType, 'application/vnd.ms-excel')
    assert.equal(xlsRes.isKnown, true)

    let genericOle = sniffMimeType(oleHeader, 'binary.dat')
    assert.equal(genericOle.mimeType, 'application/x-ole-storage')
    assert.equal(genericOle.isKnown, true)
  })

  it('sniffs WebP and SVG images', () => {
    let webpHeader = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    let webpRes = sniffMimeType(webpHeader, 'photo.webp')
    assert.equal(webpRes.mimeType, 'image/webp')
    assert.equal(webpRes.isKnown, true)

    let svgData = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>')
    let svgRes = sniffMimeType(svgData, 'diagram.svg')
    assert.equal(svgRes.mimeType, 'image/svg+xml')
    assert.equal(svgRes.isKnown, true)
  })

  it('sanitizes unsafe file names', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeFileName('..\\..\\windows\\system32\\calc.exe'), 'calc.exe')
    assert.equal(sanitizeFileName('my survey file (1) [final].pdf'), 'my_survey_file__1___final_.pdf')
    assert.equal(sanitizeFileName('   '), 'document.bin')
    assert.equal(sanitizeFileName('..'), 'document.bin')
  })
})
