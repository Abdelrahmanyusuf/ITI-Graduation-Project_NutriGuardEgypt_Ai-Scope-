import fs from 'node:fs';

const whoChunks = JSON.parse(fs.readFileSync('../data/staging/who_chunks.json', 'utf8'));
const foodPyramid = JSON.parse(fs.readFileSync('../data/raw/food_pyramid.json', 'utf8'));

if (!Array.isArray(whoChunks) || !Array.isArray(foodPyramid)) {
    throw new TypeError('Both input files must contain JSON arrays.');
}

const pyramidChunks = foodPyramid.map((item, index) => ({
    id: `food_pyramid_${index + 1}`,
    text: [
        `Category: ${item.category}`,
        `Layer: ${item.layer}`,
        item.description,
        `Recommended servings: ${item.recommended_servings}`
    ].join('\n'),
    metadata: {
        source: 'Healthy Eating Pyramid',
        language: 'en',
        type: 'food_pyramid',
        category: item.category,
        layer: item.layer
    }
}));

const combinedGuidelines = [...whoChunks, ...pyramidChunks];
const ids = combinedGuidelines.map(chunk => chunk.id);

if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate chunk IDs found while merging guideline files.');
}

fs.writeFileSync(
    '../data/processed/combined_guidelines.json',
    JSON.stringify(combinedGuidelines, null, 2),
    'utf8'
);

console.log(
    `Merged ${whoChunks.length} WHO chunks and ${pyramidChunks.length} food pyramid chunks ` +
    `into ${combinedGuidelines.length} total chunks.`
);
