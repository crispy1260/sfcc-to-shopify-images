// Required modules
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('xmldom');
const sharp = require('sharp');


// Set up file logging with timestamps
const logFile = fs.createWriteStream('debug.log', { flags: 'a' });

const log = function () {
  const timestamp = new Date().toISOString();
  const message = Array.from(arguments).join(' ');
  const logMessage = `[${timestamp}] ${message}`;
  process.stdout.write(logMessage + '\n');
  logFile.write(logMessage + '\n');
};
console.log = log;
console.error = (...args) => log('[ERROR]', ...args);
console.warn = (...args) => log('[WARN]', ...args);
console.info = (...args) => log('[INFO]', ...args);

// Sanitize strings
function sanitizeText(str) {
  return str
    .replace(/[’]/g, "'")       // curly apostrophe
    .replace(/[“”]/g, '"')      // curly quotes
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // control characters
    .replace(/[\u200B-\u200D\uFEFF]/g, '')        // zero-width spaces
    .trim();
}


// Set up directories
const catalogsDir = path.join(__dirname, 'sfcc-catalogs');
if (!fs.existsSync(catalogsDir)) {
  console.error('Catalogs directory not found:', catalogsDir);
  process.exit(1);
}
const stylesDir = path.join(__dirname, 'sfcc-styles');
if (!fs.existsSync(stylesDir)) {
  console.error('Styles directory not found:', stylesDir);
  process.exit(1);
}
const imagesDir = path.join(__dirname, 'sfcc-images');
if (!fs.existsSync(imagesDir)) {
  console.error('Images directory not found:', imagesDir);
  process.exit(1);
}
const outputDir = path.join(__dirname, 'sfcc-images-output');
if (!fs.existsSync(outputDir)) {
  console.error('Output directory not found:', outputDir);
  process.exit(1);
}

// Set up view conversions
const viewLabelMap = {
  '2': 'outsole',
  '3': 'front',
  '4': 'back',
  '5': 'instep_profile',
  '6': 'birdseye',
  '8': 'profile',
  '9': 'lifestyle'
};

const ignoredFolders = ['spins', 'spin', 'swatch'];
let xmlData = [];

const matrixifyDir = path.join(__dirname, 'matrixify');
const shopifyStylesDir = path.join(__dirname, 'shopify-styles');
if (!fs.existsSync(matrixifyDir)) fs.mkdirSync(matrixifyDir, { recursive: true });


// Step: Loop over sfcc-catalogs and load matching style filters
const stylesFiles = fs.readdirSync(stylesDir).filter(f => f.endsWith('_styles.txt'));
const stylesMap = new Map();

// Preload styles from txt files
for (const stylesFile of stylesFiles) {
  const baseName = stylesFile.replace('_styles.txt', '');
  const content = fs.readFileSync(path.join(stylesDir, stylesFile), 'utf-8');
  const styleSet = new Set(content.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  stylesMap.set(baseName, styleSet);
}

// Process XML files and filter by styles
const styles = fs.readdirSync(catalogsDir).filter(f => f.endsWith('.xml')).map(f => {
  const data = fs.readFileSync(path.join(catalogsDir, f), 'utf-8');
  const parser = new DOMParser();
  const doc = parser.parseFromString(data, 'text/xml');

  const baseName = f.replace('_catalog.xml', '').replace('.xml', '');
  const allowedStyles = stylesMap.get(baseName);
  if (!allowedStyles) {
    console.warn(`⚠️  No styles list found for catalog ${f}`);
    return null;
  }

  console.info(`📂 Processing catalog: ${f} with ${allowedStyles.size} styles`);
  const products = doc.getElementsByTagName('product');

  Array.from(products).forEach(product => {
    const productId = product.getAttribute('product-id');
    if (!allowedStyles.has(productId)) return;

    let imagePaths = [];
    const images = product.getElementsByTagName('images');
    Array.from(images).forEach(imageGroup => {
      const imageGroups = imageGroup.getElementsByTagName('image-group');
      Array.from(imageGroups).forEach(imageGroup => {
        const viewType = imageGroup.getAttribute('view-type');
        if (viewType === 'hi-res' || viewType === 'grid-large') {
          const imageList = imageGroup.getElementsByTagName('image');
          Array.from(imageList).forEach(imageListItem => {
            const imagePath = imageListItem.getAttribute('path');
            imagePaths.push(imagePath);
          });
        }
      });
    });

    if (imagePaths.length !== 0) {
      xmlData.push({ productId, images: imagePaths, xmlFileName: f });
      console.info(`✅ Images assigned to ${productId}`);
    }
  });
});




// Step 1: Grab Each Product from xmlData and recursively search for the images in sfcc-images
let productImagesAvailable = [];
xmlData.forEach(entry => {
  const { productId, images } = entry;
  let foundImages = [];
  images.forEach(imagePath => {
    const imageFile = path.join(imagesDir, 'images', imagePath);
    console.log(`Checking: ${imageFile}`);
    if (fs.existsSync(imageFile)) {
      foundImages.push(imagePath);
      console.log(`${imagePath} found`);
    } else {
      console.log(`${imagePath} not found`);
    }
  });
  if (foundImages.length > 0) {
    productImagesAvailable.push({
      productId,
      images: foundImages,
      xmlFileName: entry.xmlFileName
    });
  }
});

// Find different types of image based on folder and name after the style name
async function processProductViews() {
  for (const product of productImagesAvailable) {
    const views = new Set();
    for (const imagePath of product.images) {
      const view = await extractImageView(product.productId, imagePath);
      views.add(view);
    }
    product.views = Array.from(views);
  }
  // Show results in table
  const viewSummary = productImagesAvailable.map(({ productId, images, views }) => ({
    productId,
    imagesAvailable: images.length,
    views: views.join(', ')
  }));
  console.table(viewSummary);
}


async function extractImageView(productId, imagePath) {
  const ext = path.extname(imagePath);
  const fileName = path.basename(imagePath, ext);
  const folderName = path.dirname(imagePath).split(path.sep).pop().toLowerCase();
  const baseFolder = ignoredFolders.includes(folderName)
    ? 'default'
    : ['gray', 'white'].includes(folderName)
      ? folderName
      : 'default';
  const imageFullPath = path.join(imagesDir, 'images', imagePath);
  let imageDimensions = '';
  try {
    const metadata = await sharp(imageFullPath).metadata();
    imageDimensions = `${metadata.width}x${metadata.height}`;
  } catch (e) {
    console.warn(`Could not get dimensions for ${imageFullPath}`);
    console.warn('Reason:', e.message);
  }

  const base = fileName.startsWith(productId) ? fileName.slice(productId.length) : fileName;
  let view = base.replace(/^_/, '').toLowerCase();

  const sizeLabels = ['extralarge', 'large', 'regular', 'thumbnail'];
for (const label of sizeLabels) {
  if (view.endsWith(label)) {
    view = view.slice(0, -label.length).replace(/_+$/, '');
    break;
  }
}

// If view is empty after cleaning, assign fallback
if (!view || view.trim() === '') {
  view = 'main';
}

  if (viewLabelMap[view]) {
    view = viewLabelMap[view];
  }

  const viewName = imageDimensions
    ? `${baseFolder}-${view}-${imageDimensions}`
    : `${baseFolder}-${view}`;

  return viewName.replace(/-/g, '_');
}

function exportViewCSV() {
  const outputDir = path.join(__dirname, 'script-image-list-output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const defaultPreferredOrder = [
    'main',
    'lifestyle',
    'outsole',
    'profile',
    'front',
    'back',
    'instep_profile',
    'birdseye'
  ];

  const grayPreferredOrder = [
    'profile',
    'lifestyle',
    'main',
    'instep_profile',
    'doubleheel',
    'doublequarter',
    'outsole'
  ];

  const grouped = new Map();

  for (const product of productImagesAvailable) {
    const { productId, views = [], xmlFileName = 'unknown.xml' } = product;
    const baseName = path.basename(xmlFileName, '.xml');

    if (!grouped.has(baseName)) grouped.set(baseName, new Map());

    const catalogGroup = grouped.get(baseName);
    if (!catalogGroup.has(productId)) {
      catalogGroup.set(productId, { gray: [], nonGray: [] });
    }

    const entries = catalogGroup.get(productId);

    for (const view of views) {
      const filename = `${productId}_${view}.jpg`;
      if (view.startsWith('gray_')) {
        entries.gray.push({ filename, view });
      } else {
        entries.nonGray.push({ filename, view });
      }
    }

    // ✅ Sort gray and nonGray lists by their respective priorities
    for (const key of ['gray', 'nonGray']) {
      const preferredOrder = key === 'gray' ? grayPreferredOrder : defaultPreferredOrder;

      entries[key].sort((a, b) => {
        const viewA = a.view.replace(/^(gray_|default_|white_)/, '').replace(/_\d+x\d+$/, '');
        const viewB = b.view.replace(/^(gray_|default_|white_)/, '').replace(/_\d+x\d+$/, '');

        const indexA = preferredOrder.indexOf(viewA);
        const indexB = preferredOrder.indexOf(viewB);

        if (indexA === -1 && indexB === -1) {
          return a.view.localeCompare(b.view); // fallback alphabetical
        } else if (indexA === -1) {
          return 1;
        } else if (indexB === -1) {
          return -1;
        } else {
          return indexA - indexB;
        }
      });
    }
  }

  // ✅ Write the CSV
  for (const [baseName, catalogGroup] of grouped.entries()) {
    const outputPath = path.join(outputDir, `${baseName}-image-inventory-export.csv`);
    const header = ['productId', 'nonGrayImageFileNames', 'grayImageFileNames'];
    const csvContent = [header.join(',')];

    for (const [productId, { nonGray, gray }] of catalogGroup.entries()) {
      const nonGrayList = nonGray.map(x => x.filename).join(', ');
      const grayList = gray.map(x => x.filename).join(', ');
      const row = `"${productId}","${nonGrayList}","${grayList}"`;
      csvContent.push(row);
    }

    fs.writeFileSync(outputPath, csvContent.join('\n'), 'utf8');
    console.log(`✅ CSV exported to: ${outputPath}`);
  }
}


function copyImagesToOutput() {
  console.log('🔄 Copying image files to sfcc-images-output...');

  for (const product of productImagesAvailable) {
    const { productId, views = [], images = [] } = product;

    for (const view of views) {
      const filename = `${productId}_${view}.jpg`;

      // Find matching image path
      const match = images.find(imgPath => filename.includes(view));
      if (!match) {
        console.warn(`⚠️ No match found for ${filename}`);
        continue;
      }

      const sourcePath = path.join(imagesDir, 'images', match);
      const destPath = path.join(outputDir, filename);

      try {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`✅ Copied: ${filename}`);
      } catch (err) {
        console.warn(`❌ Failed to copy ${filename}: ${err.message}`);
      }
    }
  }

  console.log('✅ Image copy complete.');
}

function generateMatrixifyCSV() {
  const styleMapFile = path.join(shopifyStylesDir, 'rockyboots_styles.csv');
  if (!fs.existsSync(styleMapFile)) {
    console.error('❌ Missing Shopify style map CSV:', styleMapFile);
    return;
  }

  const styleMapContent = fs.readFileSync(styleMapFile, 'utf-8');
  const lines = styleMapContent.split(/\r?\n/).filter(line => line.trim());
  const styleMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const [id, title, style] = lines[i].split(',').map(s => s.trim());
    if (style) styleMap.set(style, { id, title });
  }

  const inventoryFile = path.join(__dirname, 'script-image-list-output', 'rockyboots_catalog-image-inventory-export.csv');
  if (!fs.existsSync(inventoryFile)) {
    console.error('❌ Missing image inventory CSV:', inventoryFile);
    return;
  }

  const rows = fs.readFileSync(inventoryFile, 'utf-8').split(/\r?\n/).slice(1); // skip header
  const output = [
    ['ID', 'Image Type', 'Image Src', 'Image Command', 'Image Position', 'Image Width', 'Image Height', 'Image Alt Text', 'Style']
  ];

  for (const row of rows) {
    if (!row.trim()) continue;
    const [style, nonGrayListRaw, grayListRaw] = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(s => s.replace(/^"|"$/g, '').trim());
    const productInfo = styleMap.get(style);
    if (!productInfo) continue;

    const imageList = grayListRaw ? grayListRaw.split(',') : nonGrayListRaw.split(',');
    let position = 1;

    for (const image of imageList) {
      const trimmed = image.trim();
      if (!trimmed) continue;

      const parts = trimmed.split('_');
      const dimPart = parts[parts.length - 1].replace('.jpg', '');
      const view = parts[parts.length - 2];
      const [width, height] = dimPart.includes('x') ? dimPart.split('x') : ['', ''];

      const cleanView = sanitizeText(view);
      const viewText = cleanView === 'default' ? '' : ` - ${cleanView}`;
      const cleanTitle = sanitizeText(productInfo.title);
      const altText = `${cleanTitle}${viewText}`;

      output.push([
        productInfo.id,
        'IMAGE',
        trimmed,
        'REPLACE',
        position++,
        width,
        height,
        altText,
        position === 2 ? style : '' // only show style on first row
      ]);
    }
  }

  const outPath = path.join(matrixifyDir, 'rockyboots_matrixify_image_upload.csv');
  const csvText = output.map(r => r.map(f => `"${f}"`).join(',')).join('\n');
  fs.writeFileSync(outPath, csvText, 'utf-8');
  console.log(`✅ Matrixify CSV written to: ${outPath}`);
}

processProductViews().then(() => {
  exportViewCSV();
  copyImagesToOutput();
  generateMatrixifyCSV();
});
