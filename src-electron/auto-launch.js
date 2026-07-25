import AutoLaunch from 'auto-launch'

// Define your app's auto-launch configuration
const appAutoLauncher = new AutoLaunch({
  name: 'FGC-Widget', // Replace with your app's name
});


// Enable auto-launch on user settings/preferences
export default function enableAutoLaunch() {
  appAutoLauncher.isEnabled().then((isEnabled) => {
    if (!isEnabled) {
      appAutoLauncher.enable()
        .then(() => {
          console.log('Auto-launch enabled successfully.');
        })
        .catch((error) => {
          console.error('Failed to enable auto-launch:', error);
        });
    } else {
      console.log('Auto-launch is already enabled.');
    }
  }).catch((error) => {
    console.error('Error checking auto-launch status:', error);
  });
}
