// Mountain ranges and massifs, compared as a whole: a centre and the diameter
// (metres) that takes in the range's main summits. Picking one sets the
// shared size, so two ranges are always shown at the same scale.
export const RANGES = [
  { name: 'Mont Blanc massif', region: 'Alps, France / Italy / Switzerland', lat: 45.89, lon: 6.95, size: 40000, highest: 4808 },
  { name: 'Pennine Alps (Matterhorn, Monte Rosa)', region: 'Alps, Switzerland / Italy', lat: 46.0, lon: 7.76, size: 40000, highest: 4634 },
  { name: 'Bernese Oberland', region: 'Alps, Switzerland', lat: 46.54, lon: 8.03, size: 30000, highest: 4274 },
  { name: 'Écrins massif', region: 'Alps, France', lat: 44.92, lon: 6.35, size: 30000, highest: 4102 },
  { name: 'Dolomites (Marmolada, Sella)', region: 'Alps, Italy', lat: 46.5, lon: 11.82, size: 40000, highest: 3343 },
  { name: 'Khumbu (Everest)', region: 'Himalaya, Nepal / China', lat: 27.97, lon: 86.88, size: 60000, highest: 8849 },
  { name: 'Karakoram: Baltoro (K2)', region: 'Karakoram, Pakistan / China', lat: 35.79, lon: 76.58, size: 40000, highest: 8611 },
  { name: 'Kangchenjunga massif', region: 'Himalaya, Nepal / India', lat: 27.7, lon: 88.15, size: 40000, highest: 8586 },
  { name: 'Annapurna massif', region: 'Himalaya, Nepal', lat: 28.58, lon: 83.95, size: 40000, highest: 8091 },
  { name: 'Alaska Range (Denali)', region: 'Alaska, USA', lat: 63.01, lon: -151.2, size: 60000, highest: 6190 },
  { name: 'Cordillera Blanca (Huascarán)', region: 'Andes, Peru', lat: -9.0, lon: -77.62, size: 40000, highest: 6768 },
  { name: 'Fitz Roy and Cerro Torre', region: 'Patagonia, Argentina / Chile', lat: -49.28, lon: -73.07, size: 20000, highest: 3405 },
  { name: 'Teton Range', region: 'Wyoming, USA', lat: 43.75, lon: -110.82, size: 30000, highest: 4199 },
  { name: 'Aoraki / Southern Alps', region: 'New Zealand', lat: -43.58, lon: 170.2, size: 40000, highest: 3724 },
].map((r) => ({ ...r, kind: 'range', elevation: r.highest }));

// Diameters on offer, in metres: fine steps where single mountains live,
// coarser ones for whole ranges.
export const SIZES = [2000, 3000, 5000, 7000, 10000, 15000, 20000, 30000, 40000, 60000, 80000, 100000];

export const findRange = (name) => RANGES.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
