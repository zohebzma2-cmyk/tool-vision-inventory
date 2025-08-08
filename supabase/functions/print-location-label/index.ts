import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Brother QL-800 specifications
const LABEL_WIDTH = 696  // 62mm in pixels at 300 DPI
const LABEL_HEIGHT = 200 // Adjustable height

interface LocationData {
  id: string
  qr_code: string
  name: string
  type: string
  description?: string
}

function generateQRCodeSVG(text: string, size: number = 100): string {
  // Simple QR code placeholder - in production you'd use a QR library
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" fill="white"/>
      <rect x="0" y="0" width="10" height="10" fill="black"/>
      <rect x="90" y="0" width="10" height="10" fill="black"/>
      <rect x="0" y="90" width="10" height="10" fill="black"/>
      <rect x="20" y="20" width="60" height="60" fill="white" stroke="black" stroke-width="1"/>
      <text x="50" y="55" text-anchor="middle" font-size="8" fill="black">${text}</text>
    </svg>
  `
}

function generateLabelSVG(location: LocationData): string {
  const qrSize = 120
  const qrCode = generateQRCodeSVG(location.qr_code, qrSize)
  
  return `
    <svg width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .title { font-family: Arial, sans-serif; font-size: 24px; font-weight: bold; }
          .subtitle { font-family: Arial, sans-serif; font-size: 16px; }
          .code { font-family: monospace; font-size: 14px; }
          .type { font-family: Arial, sans-serif; font-size: 12px; text-transform: uppercase; }
        </style>
      </defs>
      
      <!-- White background -->
      <rect width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" fill="white"/>
      
      <!-- Border -->
      <rect x="5" y="5" width="${LABEL_WIDTH - 10}" height="${LABEL_HEIGHT - 10}" 
            fill="none" stroke="black" stroke-width="2"/>
      
      <!-- QR Code on the left -->
      <g transform="translate(15, 40)">
        ${qrCode}
      </g>
      
      <!-- Location info on the right -->
      <g transform="translate(160, 30)">
        <!-- Location name -->
        <text x="0" y="25" class="title">${location.name}</text>
        
        <!-- Location type -->
        <text x="0" y="50" class="type">Type: ${location.type}</text>
        
        <!-- QR Code -->
        <text x="0" y="75" class="code">QR: ${location.qr_code}</text>
        
        <!-- Description if available -->
        ${location.description ? `<text x="0" y="100" class="subtitle">${location.description.substring(0, 40)}${location.description.length > 40 ? '...' : ''}</text>` : ''}
        
        <!-- Tool Inventory branding -->
        <text x="0" y="130" class="subtitle" opacity="0.6">Tool Inventory System</text>
      </g>
    </svg>
  `
}

function svgToPNG(svgString: string): Uint8Array {
  // This is a simplified approach - in production you'd use a proper SVG to PNG converter
  // For now, we'll return the SVG as bytes for demonstration
  return new TextEncoder().encode(svgString)
}

// Brother QL ESC/P commands for QL-800
function generateBrotherQLCommands(imageData: Uint8Array, width: number, height: number): Uint8Array {
  const commands: number[] = []
  
  // ESC/P initialization
  commands.push(0x1B, 0x40) // ESC @ (Initialize)
  commands.push(0x1B, 0x69, 0x7A, 0x00) // Select print information command
  commands.push(0x1B, 0x69, 0x4D, 0x40) // Various mode settings
  commands.push(0x1B, 0x69, 0x41, 0x01) // Switch to raster mode
  commands.push(0x1B, 0x69, 0x21, 0x00) // Automatic status notification
  
  // Media type (62mm continuous tape)
  commands.push(0x1B, 0x69, 0x7A, 0x86, 0x0A, 0x86, 0x0A, 0x00, 0x00, 0x03, 0x02)
  
  // Margins (0 margin)
  commands.push(0x1B, 0x69, 0x64, 0x00, 0x00)
  
  // Set label length
  commands.push(0x1B, 0x69, 0x53)
  
  // Raster data would go here - simplified for demonstration
  // In a real implementation, you'd convert the image to raster format
  
  // Print command
  commands.push(0x0C) // Form feed
  
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

    console.log('Generating label for location:', location.name)

    // Generate label SVG
    const labelSVG = generateLabelSVG(location)
    
    // Convert to image format (simplified)
    const imageData = svgToPNG(labelSVG)
    
    // Generate Brother QL print commands
    const printCommands = generateBrotherQLCommands(imageData, LABEL_WIDTH, LABEL_HEIGHT)

    // For web printing, we'll return the SVG for now
    // In production, you'd send the print commands to the printer
    
    console.log('Label generated successfully for:', location.qr_code)

    return new Response(
      JSON.stringify({ 
        success: true,
        labelSVG: labelSVG,
        message: `Label generated for ${location.name}`,
        printData: Array.from(printCommands), // Convert for JSON serialization
        instructions: 'Connect your Brother QL-800 via USB and use the Brother P-touch Editor software to print, or implement direct USB communication.'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error generating label:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to generate label', details: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})