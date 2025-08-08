import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface LocationData {
  id: string
  qr_code: string
  name: string
  type: string
  description?: string
  capacity?: number
}

// Generate a more detailed QR code representation for Brother QL printing
function generateQRMatrix(text: string, size: number = 25): number[][] {
  // Create a simple matrix representation of QR code
  // In production, you'd use a proper QR code library
  const matrix: number[][] = []
  
  for (let y = 0; y < size; y++) {
    matrix[y] = []
    for (let x = 0; x < size; x++) {
      // Create a pattern based on text hash and position
      const hash = text.split('').reduce((a, b) => a + b.charCodeAt(0), 0)
      const pattern = (x + y + hash) % 3
      matrix[y][x] = pattern === 0 ? 1 : 0
    }
  }
  
  // Add finder patterns (corners)
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      if (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)) {
        matrix[i][j] = 1
        matrix[i][size - 1 - j] = 1
        matrix[size - 1 - i][j] = 1
      }
    }
  }
  
  return matrix
}

// Convert QR matrix to bitmap data for Brother QL
function qrMatrixToBitmap(matrix: number[][], scale: number = 8): Uint8Array {
  const size = matrix.length * scale
  const bytesPerLine = Math.ceil(size / 8)
  const bitmap = new Uint8Array(size * bytesPerLine)
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const matrixY = Math.floor(y / scale)
      const matrixX = Math.floor(x / scale)
      const pixel = matrix[matrixY] && matrix[matrixY][matrixX] ? 1 : 0
      
      if (pixel) {
        const byteIndex = y * bytesPerLine + Math.floor(x / 8)
        const bitIndex = 7 - (x % 8)
        bitmap[byteIndex] |= (1 << bitIndex)
      }
    }
  }
  
  return bitmap
}

// Generate Brother QL-800 print commands
function generateBrotherQLLabel(location: LocationData): Uint8Array {
  const commands: number[] = []
  
  // Initialize printer
  commands.push(0x1B, 0x40) // ESC @ - Initialize
  
  // Invalidate
  commands.push(0x1B, 0x69, 0x4B, 0x08)
  
  // Status information request
  commands.push(0x1B, 0x69, 0x53)
  
  // Set media & quality
  commands.push(0x1B, 0x69, 0x7A, 0x86, 0x0A, 0x86, 0x0A, 0x00, 0x00, 0x03, 0x02)
  
  // Set margin (no margin)
  commands.push(0x1B, 0x69, 0x64, 0x00, 0x00)
  
  // Switch to raster mode
  commands.push(0x1B, 0x69, 0x52, 0x01)
  
  // Print information command
  commands.push(0x1B, 0x69, 0x7A, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00)
  
  // Set compression mode
  commands.push(0x1B, 0x69, 0x4D, 0x00)
  
  // Set feed amount
  commands.push(0x1B, 0x69, 0x41, 0x01)
  
  // Generate QR code bitmap
  const qrMatrix = generateQRMatrix(location.qr_code, 25)
  const qrBitmap = qrMatrixToBitmap(qrMatrix, 6)
  
  // Calculate label dimensions (62mm = 696 pixels at 300 DPI)
  const labelWidth = 696
  const labelHeight = 200
  const bytesPerLine = Math.ceil(labelWidth / 8)
  
  // Create label bitmap
  const labelBitmap = new Uint8Array(labelHeight * bytesPerLine)
  
  // Add QR code to label (position at left side)
  const qrSize = 25 * 6 // 150 pixels
  const qrStartX = 20
  const qrStartY = 25
  
  for (let y = 0; y < Math.min(qrSize, labelHeight - qrStartY); y++) {
    for (let x = 0; x < Math.min(qrSize, labelWidth - qrStartX); x++) {
      const qrByteIndex = y * Math.ceil(qrSize / 8) + Math.floor(x / 8)
      const qrBitIndex = 7 - (x % 8)
      
      if (qrBitmap[qrByteIndex] & (1 << qrBitIndex)) {
        const labelY = qrStartY + y
        const labelX = qrStartX + x
        const labelByteIndex = labelY * bytesPerLine + Math.floor(labelX / 8)
        const labelBitIndex = 7 - (labelX % 8)
        labelBitmap[labelByteIndex] |= (1 << labelBitIndex)
      }
    }
  }
  
  // Add text bitmap (simplified - just the location name)
  // In production, you'd use a proper font renderer
  const textStartX = 200
  const textStartY = 40
  
  // Simple text pattern for location name (first 10 chars)
  const name = location.name.substring(0, 10).toUpperCase()
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i)
    const charX = textStartX + i * 24
    
    // Simple character bitmap (8x16 pattern based on ASCII)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        if ((char + x + y) % 3 === 0) {
          const labelY = textStartY + y
          const labelX = charX + x
          if (labelY < labelHeight && labelX < labelWidth) {
            const byteIndex = labelY * bytesPerLine + Math.floor(labelX / 8)
            const bitIndex = 7 - (labelX % 8)
            labelBitmap[byteIndex] |= (1 << bitIndex)
          }
        }
      }
    }
  }
  
  // Send raster data
  for (let line = 0; line < labelHeight; line++) {
    // Raster line command
    commands.push(0x67, 0x00, bytesPerLine) // 'g' command with line length
    
    // Add line data
    const lineStart = line * bytesPerLine
    for (let i = 0; i < bytesPerLine; i++) {
      commands.push(labelBitmap[lineStart + i])
    }
  }
  
  // Print command
  commands.push(0x1A) // Print and feed
  
  return new Uint8Array(commands)
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { locationId } = await req.json()
    
    if (!locationId) {
      return new Response(
        JSON.stringify({ error: 'Location ID is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Get location data from database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: location, error } = await supabase
      .from('locations')
      .select('*')
      .eq('id', locationId)
      .single()

    if (error || !location) {
      console.error('Error fetching location:', error)
      return new Response(
        JSON.stringify({ error: 'Location not found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    console.log('Generating print commands for location:', location.name)

    // Generate Brother QL print commands
    const printCommands = generateBrotherQLLabel(location)

    console.log('Print commands generated successfully for:', location.qr_code)
    console.log('Command length:', printCommands.length, 'bytes')

    return new Response(
      JSON.stringify({ 
        success: true,
        printData: Array.from(printCommands),
        location: {
          name: location.name,
          qr_code: location.qr_code,
          type: location.type
        },
        message: `Label ready for ${location.name}`,
        commandLength: printCommands.length
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error generating print commands:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to generate print commands', details: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})