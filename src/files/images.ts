import { TFile, Vault } from "obsidian"

interface ImageOptions {
	downscale?: boolean
	maxDimension?: number
	quality?: number
}

/**
 * Convert an image from the Vault into webp, possibly downscaling it, and return its
 * Blob representation.
 * @param file The image's TFile
 * @param vault A reference to the Vault
 * @param options Configuration options for image processing
 * @returns A Promise resolving to the image's ArrayBuffer
 */
export async function imageToArrayBuffer(
	file: TFile,
	vault: Vault,
	options: ImageOptions = {}
): Promise<ArrayBuffer> {
	const { downscale = true, maxDimension = 1600, quality = 80 } = options

	try {
		const buf = await vault.readBinary(file)

		// Create image element
		const img = new Image()
		const url = URL.createObjectURL(new Blob([buf]))

		// Wait for image to load
		await new Promise((resolve, reject) => {
			img.onload = resolve
			img.onerror = () => reject(new Error("Failed to load image"))
			img.src = url
		})

		// Create canvas for resizing
		const canvas = document.createElement("canvas")
		let width = img.width
		let height = img.height

		if (downscale) {
			if (width > maxDimension || height > maxDimension) {
				const ratio = Math.min(
					maxDimension / width,
					maxDimension / height
				)
				width = Math.floor(width * ratio)
				height = Math.floor(height * ratio)
			}
		}

		canvas.width = width
		canvas.height = height

		// Draw resized image
		const ctx = canvas.getContext("2d")
		if (!ctx) throw new Error("Could not get canvas context")
		ctx.drawImage(img, 0, 0, width, height)

		// Convert to WebP
		return new Promise((resolve) => {
			canvas.toBlob(
				(blob) => {
					URL.revokeObjectURL(url)
					if (!blob) throw new Error("Conversion failed")
					blob.arrayBuffer().then(resolve)
				},
				"image/webp",
				quality / 100
			)
		})
	} catch (error) {
		console.error("Image processing error:", error)
		throw error
	}
}
