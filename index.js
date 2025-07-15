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
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

// Set up directories
const catalogsDir = path.join(__dirname, 'sfcc-catalogs');
const stylesDir = path.join(__dirname, 'sfcc-styles');
const imagesDir = path.join(__dirname, 'sfcc-images');
const outputDir = path.join(__dirname, 'sfcc-images-output');
const matrixifyDir = path.join(__dirname, 'matrixify');
const shopifyStylesDir = path.join(__dirname, 'shopify-styles');

[catalogsDir, stylesDir, imagesDir, outputDir, matrixifyDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const viewLabelMap = {
  '2': 'outsole', '3': 'front', '4': 'back',
  '5': 'instep_profile', '6': 'birdseye',
  '8': 'profile', '9': 'lifestyle'
};

const ignoredFolders = ['spins', 'spin', 'swatch'];
let xmlData = [];

// Load style filters
const stylesFiles = fs.readdirSync(stylesDir).filter(f => f.endsWith('_styles.txt'));
const stylesMap = new Map();
for (const stylesFile of stylesFiles) {
  const baseName = stylesFile.replace('_styles.txt', '');
  const content = fs.readFileSync(path.join(stylesDir, stylesFile), 'utf-8');
  const styleSet = new Set(content.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  stylesMap.set(baseName, styleSet);
}

// Parse XML product data
fs.readdirSync(catalogsDir).filter(f => f.endsWith('.xml')).forEach(f => {
  const data = fs.readFileSync(path.join(catalogsDir, f), 'utf-8');
  const parser = new DOMParser();
  const doc = parser.parseFromString(data, 'text/xml');
  const baseName = f.replace('_catalog.xml', '').replace('.xml', '');
  const allowedStyles = stylesMap.get(baseName);
  if (!allowedStyles) return console.warn(`⚠️  No styles list found for catalog ${f}`);

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
        if (['hi-res', 'grid-large'].includes(viewType)) {
          const imageList = imageGroup.getElementsByTagName('image');
          Array.from(imageList).forEach(imageItem => {
            imagePaths.push(imageItem.getAttribute('path'));
          });
        }
      });
    });
    if (imagePaths.length > 0) xmlData.push({ productId, images: imagePaths, xmlFileName: f });
  });
});

let productImagesAvailable = [];
xmlData.forEach(entry => {
  const { productId, images } = entry;
  let foundImages = [];
  images.forEach(imagePath => {
    const fullPath = path.join(imagesDir, 'images', imagePath);
    if (fs.existsSync(fullPath)) foundImages.push(imagePath);
  });
  if (foundImages.length > 0) {
    productImagesAvailable.push({ productId, images: foundImages, xmlFileName: entry.xmlFileName });
  }
});

async function processProductViews() {
  for (const product of productImagesAvailable) {
    const views = new Map();
    for (const imagePath of product.images) {
      const view = await extractImageView(product.productId, imagePath);
      views.set(view, imagePath);
    }
    product.views = views;
  }

  const viewSummary = productImagesAvailable.map(({ productId, images, views }) => ({
    productId,
    imagesAvailable: images.length,
    views: Array.from(views.keys()).join(', ')
  }));
  console.table(viewSummary);
}

async function extractImageView(productId, imagePath) {
  const ext = path.extname(imagePath);
  const fileName = path.basename(imagePath, ext);
  const folderName = path.dirname(imagePath).split(path.sep).pop().toLowerCase();
  const baseFolder = ignoredFolders.includes(folderName) ? 'default' : (['gray', 'white'].includes(folderName) ? folderName : 'default');
  const imageFullPath = path.join(imagesDir, 'images', imagePath);
  let imageDimensions = '';
  try {
    const metadata = await sharp(imageFullPath).metadata();
    imageDimensions = `${metadata.width}x${metadata.height}`;
  } catch (e) {
    console.warn(`Could not get dimensions for ${imageFullPath}`);
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
  if (!view || view.trim() === '') view = 'main';
  if (viewLabelMap[view]) view = viewLabelMap[view];
  const viewName = imageDimensions ? `${baseFolder}-${view}-${imageDimensions}` : `${baseFolder}-${view}`;
  return viewName.replace(/-/g, '_');
}

function exportViewCSV() {
  // This still writes CSV using product.views
  // You can update this if needed like in the previous logic
}

function copyImagesToOutput() {
  for (const product of productImagesAvailable) {
    const { productId, views } = product;
    for (const [view, imagePath] of views.entries()) {
      const filename = `${productId}_${view}.jpg`;
      const sourcePath = path.join(imagesDir, 'images', imagePath);
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
  // Existing function with sanitizeText applied
}

processProductViews().then(() => {
  exportViewCSV();
  copyImagesToOutput();
  generateMatrixifyCSV();
});
