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

// Generate Brother QL-800 print commands with proven working format
function generateBrotherQLLabel(location: LocationData, autoFormat: boolean = false): Uint8Array {
  const commands: number[] = []
  
  console.log('Generating Brother QL label for:', location.name)
  
  // 1. Invalidate command (400 bytes of 0x00)
  for (let i = 0; i < 400; i++) {
    commands.push(0x00)
  }
  
  // 2. Initialize
  commands.push(0x1B, 0x40)
  
  // 3. Switch dynamic command mode (enter raster mode)
  commands.push(0x1B, 0x69, 0x61, 0x01)
  
  // 4. Switch automatic status notification mode
  commands.push(0x1B, 0x69, 0x21, 0x00)
  
  // 5. Print information command - use current loaded media
  commands.push(
    0x1B, 0x69, 0x7A,     // Print info command
    0x86,                 // Valid flag (media type + width + length + quality)
    0x0A,                 // Media type: continuous tape (0x0A)
    0x0C,                 // Media width: 12mm (detected from status)
    0x00,                 // Media length: 0 (continuous)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00  // Reserved bytes
  )
  
  // 6. Various mode (auto cut on)
  commands.push(0x1B, 0x69, 0x4D, 0x40)
  
  // 7. Specify page number for auto cut (cut each 1 label)
  commands.push(0x1B, 0x69, 0x41, 0x01)
  
  // 8. Expanded mode (cut at end)
  commands.push(0x1B, 0x69, 0x4B, 0x08)
  
  // 9. Specify margin amount (3mm = 35 dots)
  commands.push(0x1B, 0x69, 0x64, 0x23, 0x00)
  
  // 10. Select compression mode (no compression)
  commands.push(0x4D, 0x00)
  
  // 11. Create label content with location info
  const labelHeight = 60 // Height for 12mm tape
  const bytesPerLine = 90 // 720 pins / 8 = 90 bytes per line
  
  console.log(`Creating label: ${labelHeight} lines x ${bytesPerLine} bytes/line`)
  
  // Generate raster data with location information
  for (let line = 0; line < labelHeight; line++) {
    // Raster graphics transfer command
    commands.push(0x67, 0x00, bytesPerLine) // 90 bytes per line
    
    // Create label content
    for (let byte = 0; byte < bytesPerLine; byte++) {
      let pixelByte = 0x00
      
      // Top and bottom borders
      if (line < 2 || line >= labelHeight - 2) {
        pixelByte = 0xFF
      }
      // Left and right borders  
      else if (byte < 2 || byte >= bytesPerLine - 2) {
        pixelByte = 0xFF
      }
      // QR Code area (simplified pattern on left side)
      else if (byte >= 4 && byte <= 24 && line >= 4 && line <= 56) {
        const qrPattern = (line + byte + location.qr_code.length) % 3
        pixelByte = qrPattern === 0 ? 0xFF : 0x00
      }
      // Text area (simplified text pattern in middle)
      else if (byte >= 30 && byte <= 80 && line >= 20 && line <= 40) {
        // Create text pattern based on location name
        const charIndex = Math.floor((byte - 30) / 8)
        const charLine = line - 20
        if (charIndex < location.name.length) {
          const char = location.name.charCodeAt(charIndex)
          const pattern = (char + charLine + (byte % 8)) % 4
          pixelByte = pattern === 0 ? 0xFF : 0x00
        }
      }
      // Location ID text area (bottom)
      else if (byte >= 30 && byte <= 80 && line >= 45 && line <= 55) {
        const idText = location.id.substring(0, 8)
        const charIndex = Math.floor((byte - 30) / 6)
        if (charIndex < idText.length) {
          const char = idText.charCodeAt(charIndex)
          const pattern = (char + line + byte) % 5
          pixelByte = pattern === 0 ? 0xFF : 0x00
        }
      }
      
      commands.push(pixelByte)
    }
  }
  
  // 12. Print command with feeding (end of page)
  commands.push(0x1A)
  
  console.log(`Generated ${commands.length} bytes of print commands`)
  return new Uint8Array(commands)
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { locationId, autoFormat = false } = await req.json()
    
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

    console.log('Generating print commands for location:', location.name, 'Auto-format:', autoFormat)

    // Generate Brother QL print commands with auto-format option
    const printCommands = generateBrotherQLLabel(location, autoFormat)

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