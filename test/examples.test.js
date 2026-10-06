'use strict';
// Validates the example workflows against the node definitions: every Dzengi parameter must
// exist and be visible for the chosen resource/operation, option values must be valid and
// connections must point at existing nodes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Dzengi } = require('../dist/nodes/Dzengi/Dzengi.node');
const { DzengiTrigger } = require('../dist/nodes/Dzengi/DzengiTrigger.node');

const nodeTypes = {
	'n8n-nodes-dzengi.dzengi': new Dzengi(),
	'n8n-nodes-dzengi.dzengiTrigger': new DzengiTrigger(),
};

function isVisible(property, parameters) {
	const show = property.displayOptions?.show ?? {};
	const hide = property.displayOptions?.hide ?? {};
	const valuesOf = (key) => {
		const value = parameters[key];
		return Array.isArray(value) ? value : [value];
	};
	for (const [key, allowed] of Object.entries(show)) {
		if (!valuesOf(key).some((value) => allowed.includes(value))) return false;
	}
	for (const [key, hidden] of Object.entries(hide)) {
		if (valuesOf(key).some((value) => hidden.includes(value))) return false;
	}
	return true;
}

function withDefaults(nodeType, parameters) {
	const merged = { ...parameters };
	for (const property of nodeType.description.properties) {
		if (!(property.name in merged) && isVisible(property, merged)) merged[property.name] = property.default;
	}
	return merged;
}

const dir = path.join(__dirname, '..', 'examples');
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
	test(`example workflow ${file} matches the node definitions`, () => {
		const workflow = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
		const names = new Set(workflow.nodes.map((node) => node.name));
		for (const [from, outputs] of Object.entries(workflow.connections)) {
			assert.ok(names.has(from), `${file}: unknown source node ${from}`);
			for (const connection of outputs.main.flat()) assert.ok(names.has(connection.node), `${file}: unknown target ${connection.node}`);
		}

		for (const node of workflow.nodes) {
			const nodeType = nodeTypes[node.type];
			if (!nodeType) continue;
			const parameters = withDefaults(nodeType, node.parameters);
			for (const [name, value] of Object.entries(node.parameters)) {
				const candidates = nodeType.description.properties.filter((property) => property.name === name);
				assert.ok(candidates.length, `${file} › ${node.name}: unknown parameter "${name}"`);
				const visible = candidates.find((property) => isVisible(property, parameters));
				assert.ok(visible, `${file} › ${node.name}: parameter "${name}" is hidden for this resource/operation`);

				const isExpression = typeof value === 'string' && value.startsWith('=');
				if (visible.type === 'options' && !visible.typeOptions?.loadOptionsMethod && !isExpression) {
					assert.ok(visible.options.some((option) => option.value === value), `${file} › ${node.name}: invalid ${name}=${value}`);
				}
				if (visible.type === 'multiOptions' && !visible.typeOptions?.loadOptionsMethod) {
					for (const entry of value) assert.ok(visible.options.some((option) => option.value === entry), `${file} › ${node.name}: invalid ${name} entry ${entry}`);
				}
				if (visible.type === 'collection') {
					for (const key of Object.keys(value)) {
						assert.ok(visible.options.some((option) => option.name === key), `${file} › ${node.name}: unknown ${name}.${key}`);
					}
				}
			}
		}
	});
}
