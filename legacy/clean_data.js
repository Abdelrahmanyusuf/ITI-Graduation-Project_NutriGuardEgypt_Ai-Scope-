import fs from 'node:fs';
import csv from 'csv-parser';

function cleanNumber(value) {
    if (!value) return 0;
    const parsed = Number.parseFloat(value.toString().replace(/[^0-9.-]/g, ''));
    return Number.isNaN(parsed) ? 0 : parsed;
}

function parseArray(value, lowercase = true) {
    if (!value) return [];

    const cleanItem = (item) => {
        const cleaned = item.toString().trim();
        return lowercase ? cleaned.toLowerCase() : cleaned;
    };

    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.map(cleanItem);
        }
    } catch {
        // Fall back to comma-separated values when the field is not JSON.
    }

    return value.split(',').map(cleanItem).filter(Boolean);
}

// 1. معالجة وتنظيف ملف القيم الغذائية (Egyptian_Food_Categorized.csv)
function processNutritionData(filePath) {
    const cleanedIngredients = [];

    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            const ingredient = {
                // توحيد النص للربط المباشر
                name_en: row.FOOD ? row.FOOD.trim().toLowerCase() : '',
                category: row.main_category ? row.main_category.trim() : 'General',
                calories_100g: cleanNumber(row['ENERGY (Kcal)']),
                fats_100g: cleanNumber(row['FAT (g)']),
                sodium_mg_100g: cleanNumber(row['SODIUM (mg)']),
                carbs_100g: cleanNumber(row['CARBOHYDRATE  (g)']),
                protein_100g: cleanNumber(row['PROTEIN (g)'])
            };

            if (ingredient.name_en) {
                cleanedIngredients.push(ingredient);
            }
        })
        .on('end', () => {
            console.log(`✅ تم تنظيف ${cleanedIngredients.length} مكون غذائي بنجاح!`);
            // حفظ النتيجة كـ JSON جاهز للإدخال في SQL
            fs.writeFileSync('../data/processed/cleaned_ingredients.json', JSON.stringify(cleanedIngredients, null, 2));
        });
}

// 2. معالجة وتنظيف ملف الوصفات (Recipes For Eqyption Food.csv)
function processRecipesData(filePath) {
    const cleanedRecipes = [];

    fs.createReadStream(filePath)
        .pipe(csv({ separator: '\t' }))
        .on('data', (row) => {
            const recipe = {
                name_en: row.recipe_title ? row.recipe_title.trim() : '',
                // تقسيم المكونات إلى Array وتنظيف المتاهات النصية
                ingredients_raw: parseArray(row.ingredients_canonical || row.ingredients),
                instructions: parseArray(row.directions, false)
            };

            if (recipe.name_en) {
                cleanedRecipes.push(recipe);
            }
        })
        .on('end', () => {
            console.log(`✅ تم تنظيف ${cleanedRecipes.length} وصفة مصرية بنجاح!`);
            fs.writeFileSync('../data/processed/cleaned_recipes.json', JSON.stringify(cleanedRecipes, null, 2));
        });
}

// تشغيل الدوال على ملفاتك
processNutritionData('../data/raw/Egyptian_Food_Categorized.csv');
processRecipesData('../data/raw/Recipes For Eqyption Food.csv');
