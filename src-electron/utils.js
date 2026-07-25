import { app } from 'electron'
import fs from 'fs'
import { join } from 'path'

export default function enableLinuxAutoStart() {
  // Get user autostart directory
  const autostartDir = join(app.getPath('home'), '.config', 'autostart')
  if (!fs.existsSync(autostartDir)) {
    fs.mkdirSync(autostartDir, { recursive: true }) // Ensure the directory exists
  }

  // Path to your .desktop file
  const desktopFilePath = join(autostartDir, 'fgc-widget.desktop')

  // Path to your app executable
  const execPath = app.getPath('exe') // Adjust to your app's binary location

  // Write the .desktop file content
  const desktopFileContent = `
[Desktop Entry]
Type=Application
Name=FGC Widget
Exec="${execPath}" --hidden
Icon=${join(__dirname, 'icons/icon.png')}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
  `

  // Write the .desktop file
  fs.writeFileSync(desktopFilePath, desktopFileContent)
  console.log('Autostart enabled! Created .desktop file at:', desktopFilePath)
}
