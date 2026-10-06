// Removes the build output.
require('fs').rmSync(require('path').resolve(__dirname, '..', 'dist'), { recursive: true, force: true });
