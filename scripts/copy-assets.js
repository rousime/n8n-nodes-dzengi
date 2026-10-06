// Copies node icons and codex files next to the compiled nodes (n8n loads them from dist).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const copied = [];

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const source = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(source);
		} else if (/\.(svg|png|json)$/.test(entry.name)) {
			const target = path.join(root, 'dist', path.relative(root, source));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(source, target);
			copied.push(path.relative(root, target));
		}
	}
}

for (const folder of ['nodes', 'credentials', 'icons']) {
	const dir = path.join(root, folder);
	if (fs.existsSync(dir)) walk(dir);
}
console.log(`Copied ${copied.length} asset(s): ${copied.join(', ')}`);
