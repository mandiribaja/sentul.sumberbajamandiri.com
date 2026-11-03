/**
 * process-spintax.js
 *
 * Expands {option1|option2|...} spintax found in config.toml `[[params.testimonials]]` and writes
 * the result to data/testimonials.yaml.
 *
 * NOT hooked into the build by default: Sumber Baja Mandiri's testimonials are plain text (no spintax)
 * and the hugo-bangunan theme reads them straight from config params, not from data/. Run it
 * manually (`npm run spintax`) only if you later add spintax AND a template that reads
 * `.Site.Data.testimonials`.
 */

const fs = require('fs');
const path = require('path');
const toml = require('toml');
const yaml = require('js-yaml');

function findConfigFile(startPath) {
  let currentPath = startPath;
  while (currentPath !== path.parse(currentPath).root) {
    const configPath = path.join(currentPath, 'config.toml');
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    currentPath = path.dirname(currentPath);
  }
  return null;
}

function processSpintax(text) {
  if (typeof text !== 'string') return text;

  const regex = /\{([^{}]+)\}/g;
  let result = text;
  let match;

  while ((match = regex.exec(result)) !== null) {
    const options = match[1].split('|');
    const replacement = options[Math.floor(Math.random() * options.length)];
    result = result.substring(0, match.index) + replacement + result.substring(match.index + match[0].length);
    regex.lastIndex = 0;
  }

  return result;
}

try {
  const configPath = findConfigFile(__dirname);
  if (!configPath) {
    throw new Error('config.toml not found in the project directory or its parent directory.');
  }

  console.log(`Using config.toml from: ${configPath}`);

  const config = toml.parse(fs.readFileSync(configPath, 'utf8'));
  const testimonials = (config.params && config.params.testimonials) || [];

  const processedTestimonials = testimonials.map(testimonial => ({
    ...testimonial,
    name: processSpintax(testimonial.name),
    message: processSpintax(testimonial.message),
    response: processSpintax(testimonial.response)
  }));

  const dataDir = path.join(path.dirname(configPath), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'testimonials.yaml'), yaml.dump({ testimonials: processedTestimonials }));

  console.log(`Testimonials processed (${processedTestimonials.length}) and data/testimonials.yaml written.`);
  if (processedTestimonials[0]) console.log(processedTestimonials[0].message);
} catch (error) {
  console.error('There is an error:', error.message);
  process.exit(1);
}
