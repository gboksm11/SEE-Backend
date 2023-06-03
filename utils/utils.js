// Utils.js defines a couple of helper functions used in yolo.js

const { createCanvas, ImageData, toDataURL } = require('canvas');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// recursively prints out all attributes of a given object
function printAttributes(obj, prefix = '') {
    for (const key in obj) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            printAttributes(obj[key], prefix + key + '.');
        } else {
            console.log(prefix + key + ':', obj[key]);
        }
    }
    console.log();
    console.log();
}

// converts a Canvas object to a png file, and saves it in the ./faces directory
async function canvasToPng(canvas, fileName) {
        // Convert canvas to PNG data URL
        const buffer = canvas.toBuffer('image/png');
    
        // Convert base64 data to buffer
        //const buffer = Buffer.from(base64Data, 'base64');
    
        // Specify the output file path
        const outputDirectory = path.join(__dirname, '..', 'public', 'faces', fileName);
    
        // Save the buffer as an image file
        await fs.promises.writeFile(outputDirectory, buffer);
    
        console.log('Image saved successfully.');
}

// converts an i420 frame to a canvas object
async function i420ToCanvas(data, width, height) {
    // Convert I420 (YUV420p) to RGB
    const ySize = width * height;
    const uvSize = (width / 2) * (height / 2);
    const yPlane = data.subarray(0, ySize);
    const uPlane = data.subarray(ySize, ySize + uvSize);
    const vPlane = data.subarray(ySize + uvSize, ySize + 2 * uvSize);

    const rgbData = new Uint8Array(width * height * 4); // We need 4 channels for ImageData
    let indexY = 0;
    let indexUV = 0;
    let indexRGB = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const Y = yPlane[indexY++];
            const U = uPlane[indexUV];
            const V = vPlane[indexUV];

            const C = Y - 16;
            const D = U - 128;
            const E = V - 128;

            rgbData[indexRGB++] = Math.min(255, Math.max(0, (298 * C + 409 * E + 128) >> 8));
            rgbData[indexRGB++] = Math.min(255, Math.max(0, (298 * C - 100 * D - 208 * E + 128) >> 8));
            rgbData[indexRGB++] = Math.min(255, Math.max(0, (298 * C + 516 * D + 128) >> 8));
            rgbData[indexRGB++] = 255; // Add an alpha channel with full opacity

            if (x % 2 === 1) {
                indexUV++;
            }
        }

        if (y % 2 === 0) {
            indexUV -= width / 2;
        }
    }

    const clampedRgbData = new Uint8ClampedArray(rgbData.buffer);

    // Create a canvas and draw the RGB data onto it
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(clampedRgbData, width, height);
    ctx.putImageData(imageData, 0, 0);

    return canvas;
}

module.exports = {
    printAttributes: printAttributes,
    i420ToCanvas: i420ToCanvas,
    canvasToPng: canvasToPng
}

exports.printAttributes = printAttributes;