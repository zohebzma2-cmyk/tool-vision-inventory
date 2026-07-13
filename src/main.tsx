import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { initNative } from './lib/native'

// Self-hosted fonts (work offline inside the iOS wrapper)
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

void initNative();
createRoot(document.getElementById("root")!).render(<App />);
