import { readFile } from 'node:fs/promises';
import {
  PDFDocument, PDFHexString, StandardFonts, beginText, endText, popGraphicsState,
  pushGraphicsState, rgb, setFillingColor, setFontAndSize, setTextMatrix, showText,
} from 'pdf-lib';
import { isDateKey } from '../utils/businessDate.js';

const template = new URL('../assets/yellowblock-invoice-template.pdf', import.meta.url);
const fontData = new URL('../assets/yellowblock-invoice-fonts.json', import.meta.url);
const ink = rgb(0.9922, 0.349, 0.2196);
const amounts = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const priceLabel = cents => `AED${amounts.format(cents / 100)}`;
const categories = [
  'Cheeses', 'Accompaniments', 'Accessories', 'Florals',
];
const table = {
  left: 144.746, unit: 385.34, price: 432.402, total: 485.947, right: 547.896,
  headerTop: 642.61, headerBottom: 629.39,
  handlingHeight: 22.955, subtotalHeight: 20.791, totalHeight: 20.911,
  minimumBottom: 288,
};
const lineHeight = 8.753;
const listOffset = 17.506;

export class InvoiceInputError extends Error {}

function readPrice(input, label) {
  const value = String(input ?? '').trim();
  if (!value) return null;
  const match = /^(\d{0,7})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new InvoiceInputError(`Enter a valid AED price for ${label}, with up to two decimal places.`);
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function readText(input, label, limit) {
  const value = typeof input === 'string' ? input.normalize('NFC').trim() : '';
  if (value.length > limit || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value.replace(/\r\n/g, '\n'))) {
    throw new InvoiceInputError(`${label} is too long or contains invalid characters.`);
  }
  return value;
}

function readDate(input, label) {
  if (!input) return '';
  if (!isDateKey(input)) throw new InvoiceInputError(`Enter a valid ${label}.`);
  return dates.format(new Date(`${input}T00:00:00Z`));
}

function readInvoice(input) {
  const field = name => input.enabled?.[name] === false ? undefined : input[name];
  const number = readText(field('invoiceNumber'), 'Invoice number', 30);
  if (number && !/^[a-z0-9/_-]+$/i.test(number)) throw new InvoiceInputError('Use letters, numbers, slashes, underscores or hyphens in the invoice number.');
  const legacyPackage = input.priceEntry === 'package';
  const items = categories.flatMap(name => {
    const item = input.categories?.[name];
    if (!item || item.enabled === false) return [];
    const separate = name === 'Florals' && input.floralBilling === 'separate';
    const details = readText(item.details, name, 1500);
    const amount = item.priceEnabled === false || (legacyPackage && !separate) ? null : readPrice(item.price, name);
    return details || amount !== null ? [{ name, details, amount, separate }] : [];
  });
  const florals = items.find(item => item.separate);
  const grazeItems = items.filter(item => !item.separate);
  if (input.enabled?.installation !== false) {
    const details = readText(field('installation'), 'Custom installation', 1500);
    const amount = readPrice(field('installationPrice'), 'custom installation');
    if (details || amount !== null) grazeItems.push({ name: 'Custom Installation', details, amount });
  }
  const packagePrice = input.priceEntry === 'categories' ? null : readPrice(field('packagePrice'), 'the graze package');
  const grazePrices = [packagePrice, ...grazeItems.map(item => item.amount)].filter(amount => amount !== null);
  const service = grazePrices.length ? grazePrices.reduce((sum, amount) => sum + amount, 0) : null;
  const handling = input.enabled?.handling === false || input.enabled?.handlingPrice === false
    ? null : readPrice(input.handling, 'handling');
  const showHandling = input.enabled?.handling === true || handling !== null;
  const prices = [service, florals?.amount ?? null, handling].filter(amount => amount !== null);
  const subtotal = prices.reduce((sum, amount) => sum + amount, 0);
  const customerTrn = readText(field('customerTrn'), 'Customer TRN', 25);
  if (customerTrn && !/^\d+$/.test(customerTrn)) throw new InvoiceInputError('Enter the Customer TRN using digits only.');
  const vat = Math.floor((subtotal + 10) / 20);
  return {
    number, grazeItems, packagePrice, service, florals, handling, showHandling, showTotals: prices.length > 0, subtotal, vat, total: subtotal + vat,
    customerTrn,
    customer: readText(field('customer'), 'Customer name', 120).toUpperCase(),
    address: readText(field('address'), 'Address', 300),
    telephone: readText(field('telephone'), 'Telephone', 40),
    eventDate: readDate(field('eventDate'), 'event date'),
    invoiceDate: readDate(field('invoiceDate'), 'invoice date'),
  };
}

function makeTextWriter(page, glyphs, fallbackFonts) {
  const bottom = page.getMediaBox().y;
  const fallbackNames = Object.fromEntries(Object.entries(fallbackFonts).map(([face, font]) => [face, page.node.newFontDictionary('YbFallback', font.ref)]));
  const runs = (text, face, size) => {
    const result = [];
    for (const char of text) {
      const glyph = glyphs[face][char];
      const last = result.at(-1);
      const isFallback = !glyph;
      const run = last?.isFallback === isFallback ? last : { isFallback, content: '', width: 0 };
      if (run !== last) result.push(run);
      if (glyph) {
        run.content += glyph[0];
        run.width += (glyph[1] / 1000) * size;
      } else {
        try {
          run.width += fallbackFonts[face].widthOfTextAtSize(char, size);
        } catch {
          throw new InvoiceInputError(`The invoice font does not support ${JSON.stringify(char)}.`);
        }
        run.content += char;
      }
    }
    return result;
  };

  const measure = (text, face, size) => runs(text, face, size).reduce((total, run) => total + run.width, 0);
  const draw = (text, x, y, { face = 'YbRegular', size = 7.5, width, align = 'left' } = {}) => {
    if (!text) return;
    y += bottom;
    const measured = measure(text, face, size);
    if (width && measured > width) size = size * width / measured;
    const pieces = runs(text, face, size);
    if (align === 'right') x -= pieces.reduce((total, run) => total + run.width, 0);
    page.pushOperators(
      pushGraphicsState(), beginText(), setFillingColor(ink), setTextMatrix(1, 0, 0, 1, x, y),
      ...pieces.flatMap(({ content, isFallback }) => [
        setFontAndSize(isFallback ? fallbackNames[face] : face, size),
        showText(isFallback ? fallbackFonts[face].encodeText(content) : PDFHexString.of(content)),
      ]),
      endText(), popGraphicsState(),
    );
  };

  const lines = (text, { width, max = Infinity, label, face = 'YbRegular', size = 7.5, bullet = false }) => {
    const result = [];
    for (const entry of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      let line = bullet ? '•' : '';
      for (const word of entry.replace(/^[•]\s*/, '').split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (measure(next, face, size) <= width) line = next;
        else {
          if (!line || line === '•' || measure(word, face, size) > width) {
            throw new InvoiceInputError(`A word in ${label} does not fit the invoice template. Shorten it and try again.`);
          }
          result.push(line);
          line = word;
        }
      }
      result.push(line);
    }
    if (result.length > max) throw new InvoiceInputError(`${label} needs more than ${max} lines. Shorten it to keep the original layout.`);
    return result;
  };
  return { draw, lines };
}

function renderTable(page, invoice, draw, lines) {
  const showGraze = invoice.grazeItems.length > 0 || invoice.service !== null;
  if (!showGraze && !invoice.florals && !invoice.showHandling) return;

  const pageBottom = page.getMediaBox().y;
  const rule = (x1, y1, x2, y2) => page.drawLine({
    start: { x: x1, y: y1 + pageBottom }, end: { x: x2, y: y2 + pageBottom }, color: ink, thickness: 0.96,
  });
  const horizontal = y => rule(table.left, y, table.right, y);
  const drawPrice = (amount, y) => {
    if (amount === null) return;
    draw('1', 404.315, y, { size: 7.003 });
    draw(priceLabel(amount), 436.05, y, { size: 7.113, width: 49 });
    draw(priceLabel(amount), 491.886, y, { size: 7.113, width: 55 });
  };
  for (const [label, x] of [['SERVICE', 148.644], ['DESCRIPTION', 239.671], ['UNIT', 399.664], ['PRICE', 450.524], ['TOTAL', 503.078]]) {
    draw(label, x, 634.39, { face: 'YbTitle', size: 7.6 });
  }
  horizontal(table.headerTop);
  horizontal(table.headerBottom);

  let bottom = table.headerBottom;
  let row = 1;
  if (showGraze) {
    ['1. CREATIVE', 'DIRECTION &', 'BESPOKE GRAZE', 'DESIGN'].forEach((line, index) => {
      draw(line, 148.644, 612.344 - index * 8.253, { face: 'YbSemibold', size: 7.6 });
    });
    ['Decorative Elements and Display', 'Items: This includes the cost of on', 'ground planning and management', 'of the grazing table'].forEach((line, index) => {
      draw(line, 241.079, 612.52 - index * 8.253, { size: 7.6 });
    });

    const showsPackageBreakdown = invoice.packagePrice !== null && invoice.grazeItems.some(item => item.amount !== null);
    let left = 567.015;
    let right = 568.837;
    if (showsPackageBreakdown) {
      draw(`Graze package: ${priceLabel(invoice.packagePrice)}`, 151.683, left, { face: 'YbSemibold', width: 123 });
      left -= 21.757;
    }
    for (const item of invoice.grazeItems) {
      const onLeft = item.name === 'Cheeses' || item.name === 'Accessories';
      const [x, y, width] = onLeft ? [151.683, left, 123] : [278.52, right, 102];
      const label = item.amount === null ? `${item.name}:` : `${item.name}: ${priceLabel(item.amount)}`;
      draw(label, x, y, { face: 'YbSemibold', size: 7.503, width });
      const entries = lines(item.details, { width, label: item.name, bullet: true });
      entries.forEach((line, index) => draw(line, x, y - listOffset - index * lineHeight));
      const end = entries.length ? y - listOffset - (entries.length - 1) * lineHeight : y;
      if (onLeft) left = end - 21.757;
      else right = end - 21.757;
    }
    bottom = Math.min(578, left + 21.757, right + 21.757) - 7.034;
    if (!showsPackageBreakdown && !invoice.grazeItems.length) bottom = 578;
    drawPrice(invoice.service, (table.headerBottom + bottom) / 2 - 3);
    horizontal(bottom);
    row++;
  }
  if (invoice.florals) {
    const top = bottom;
    const entries = lines(invoice.florals.details, { width: 141, label: 'Floral décor', size: 7.113 });
    bottom -= Math.max(28, entries.length * lineHeight + 11);
    const y = (top + bottom) / 2 - 2;
    draw(`${row++}. FLORAL DÉCOR`, 148.644, y, { face: 'YbSemibold', size: 8.003 });
    entries.forEach((line, index) => draw(line, 238.5, top - 11 - index * lineHeight, { size: 7.113 }));
    drawPrice(invoice.florals.amount, y);
    horizontal(bottom);
  }
  if (invoice.showHandling) {
    bottom -= table.handlingHeight;
    const y = bottom + 7.307;
    draw(`${row}. HANDLING, ASSEMBLY, AND DISASSEMBLY`, 148.644, y, { face: 'YbSemibold', size: 8.003 });
    drawPrice(invoice.handling, y);
    horizontal(bottom);
  }
  for (const x of [table.unit, table.price]) rule(x, table.headerTop, x, bottom);

  if (invoice.showTotals) {
    bottom -= table.subtotalHeight;
    draw('TOTAL', 148.644, bottom + 1.922, { face: 'YbSemibold', size: 9.003 });
    draw(priceLabel(invoice.subtotal), 488.066, bottom + 1.922, { face: 'YbSemibold', size: 9.003, width: 60 });
    horizontal(bottom);
    bottom -= table.totalHeight;
    draw('SUBTOTAL', 148.644, bottom + 2.106, { face: 'YbSemibold', size: 9.003 });
    draw('VAT +5%', 395.434, bottom + 2.445, { size: 6.497 });
    draw(priceLabel(invoice.vat), 443.853, bottom + 2.445, { size: 6.497, width: 40 });
    draw(priceLabel(invoice.total), 488.066, bottom + 2.106, { face: 'YbSemibold', size: 9.003, width: 60 });
    horizontal(bottom);
  }
  rule(table.total, table.headerTop, table.total, bottom);
  if (bottom < table.minimumBottom) {
    throw new InvoiceInputError('The item lists do not fit above the payment details. Shorten the lists to keep the invoice on one page.');
  }
}

export async function generateYellowblockInvoice(input) {
  const invoice = readInvoice(input ?? {});
  const [source, metrics] = await Promise.all([readFile(template), readFile(fontData, 'utf8')]);
  const pdf = await PDFDocument.load(source);
  const [regular, semibold, title] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold), pdf.embedFont(StandardFonts.TimesRomanBold),
  ]);
  const page = pdf.getPage(0);
  const { draw, lines } = makeTextWriter(page, JSON.parse(metrics), { YbRegular: regular, YbSemibold: semibold, YbTitle: title });
  draw(invoice.number, 553.12, 781.168, { face: 'YbTitle', size: 10.001, width: 103, align: 'right' });
  if (invoice.customerTrn) {
    const nameStyle = { face: 'YbSemibold', size: 8.006 };
    lines(invoice.customer, { ...nameStyle, width: 91, max: 3, label: 'Customer name' })
      .forEach((line, index) => draw(line, 46.334, 593.989 - index * 9, nameStyle));
    draw('TRN:', 46.334, 496.7, { face: 'YbSemibold', size: 7.465 });
    draw(invoice.customerTrn, 46.334, 488.447, { size: 7.465, width: 91 });
  } else draw(invoice.customer, 46.334, 593.989, { face: 'YbSemibold', size: 8.006, width: 91 });
  const detailLabel = (label, y) => draw(label, 46.334, y, { face: 'YbSemibold', size: 7.465 });
  if (invoice.address) {
    detailLabel('Address:', 560.835);
    lines(invoice.address, { width: 91, max: 3, label: 'Address', size: 7.465 }).forEach((line, index) => draw(line, 46.334, 552.587 - index * 8.253, { size: 7.465 }));
  }
  for (const [label, value, y] of [['Telephone:', invoice.telephone, 511.221], ['Event Date:', invoice.eventDate, 469.709], ['Invoice Date:', invoice.invoiceDate, 430.054]]) {
    if (!value) continue;
    detailLabel(label, y + 8.253);
    draw(value, 46.334, y, { size: 7.465, width: 91 });
  }

  const sellerTrn = process.env.YELLOWBLOCK_INVOICE_SELLER_TRN?.trim();
  const iban = process.env.YELLOWBLOCK_INVOICE_IBAN?.trim();
  const bic = process.env.YELLOWBLOCK_INVOICE_BIC?.trim();
  if (sellerTrn) draw(`TRN ${sellerTrn}`, 46.334, 783.663, { face: 'YbSemibold', size: 10, width: 175 });
  if (iban) {
    ['Thank you for choosing to collaborate', 'with us! Please transfer the invoice', 'amount to the below details:'].forEach((line, index) => {
      draw(line, 46.552, 263.61 - index * 10.504, { size: 10 });
    });
    draw(`IBAN: ${iban}`, 46.334, 183.33, { size: 11, width: 185 });
  }
  if (bic) draw(`BIC: ${bic}`, 46.334, 170.58, { size: 11, width: 185 });

  renderTable(page, invoice, draw, lines);

  pdf.setTitle(`Yellow Block invoice${invoice.number ? ` ${invoice.number}` : ''}`);
  const filename = `Yellow-Block-invoice${invoice.number ? `-${invoice.number.replaceAll('/', '-')}` : ''}.pdf`;
  return { bytes: await pdf.save(), filename };
}
