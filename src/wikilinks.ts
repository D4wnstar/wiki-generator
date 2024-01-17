import { TFile, Vault } from "obsidian"
import { Backreference, Note } from "./format"
import { SupabaseClient } from "@supabase/supabase-js"
import Image from "image-js"
import { storedMedia, uploadConfig } from "./config"
import { Database } from "./database/database.types"
import { slugifyPath } from "./utils"

function backrefAlreadyExists(
	displayName: string,
	slug: string,
	backrefs: Backreference[]
): boolean {
	for (const backref of backrefs) {
		if (backref.displayName === displayName && backref.slug === slug) {
			return true
		}
	}

	return false
}

function findReferencedNote(noteName: string, notes: Note[]): Note | undefined {
	// Check if the path is explicit (like [[Enciclopedia Antediluviana/Nazioni/Auriga]])
	// or implicit (like [[Auriga]]). If it's implicit, the note name is unique.
	let refNote: Note | undefined
	if (noteName.split("/").filter((elem) => elem !== "").length > 1) {
		refNote = notes.find((note) => note.slug === slugifyPath(noteName))
	} else {
		refNote = notes.find(
			(note) => note.title.toLowerCase() === noteName.toLowerCase()
		)
	}

	return refNote
}

export function findClosestWidthClass(width: number): string {
	const widthToClass = new Map([
		// Standard Tailwind utility classes
		[0, "w-0"],
		[1, "w-px"],
		[2, "w-0.5"],
		[4, "w-1"],
		[6, "w-1.5"],
		[8, "w-2"],
		[10, "w-2.5"],
		[12, "w-3"],
		[14, "w-3.5"],
		[16, "w-4"],
		[20, "w-5"],
		[24, "w-6"],
		[28, "w-7"],
		[32, "w-8"],
		[36, "w-9"],
		[40, "w-10"],
		[44, "w-11"],
		[48, "w-12"],
		[56, "w-14"],
		[64, "w-16"],
		[80, "w-20"],
		[96, "w-24"],
		[112, "w-28"],
		[128, "w-32"],
		[144, "w-36"],
		[160, "w-40"],
		[176, "w-44"],
		[192, "w-48"],
		[208, "w-52"],
		[224, "w-56"],
		[240, "w-60"],
		[256, "w-64"],
		[288, "w-72"],
		[320, "w-80"],
		[384, "w-96"],
		// Custom utility classes
		[400, "w-100"],
		[440, "w-110"],
		[480, "w-120"],
		[520, "w-130"],
		[560, "w-140"],
		[600, "w-150"],
		[640, "w-160"],
		[680, "w-170"],
		[720, "w-180"],
		[760, "w-190"],
		[800, "w-200"],
	])

	let lowestDist = Infinity
	let finalClass = "w-60"
	for (const [targetWidth, widthClass] of widthToClass.entries()) {
		const currDist = Math.abs(targetWidth - width)
		if (currDist < lowestDist) {
			lowestDist = currDist
			finalClass = widthClass
		}
	}

	return finalClass
}

export async function uploadImage(
	fileBuffer: ArrayBuffer,
	filename: string,
	supabase: SupabaseClient<Database>
): Promise<string | undefined> {
	// Change the extension to webp before conversion
	const newFilename = filename.replace(/\..*$/, ".webp")

	if (!uploadConfig.overwriteFiles) {
		// Check if the file already exists
		const storedFile = storedMedia.files.find((name) => name === newFilename)

		// If it exists, avoid attempting a new upload and just get the URL instead
		if (storedFile) {
			console.log(`Found existing file ${storedFile}`)
			const urlData = supabase.storage
				.from("images")
				.getPublicUrl(storedFile)

			return urlData.data.publicUrl
		}
	}

	// Push to the (local) list of stored files
	storedMedia.files.push(newFilename)

	// If it doesn't exists, load the image to manipulate it
	let image = await Image.load(fileBuffer)

	// Compress the image if it's overly large
	if (image.height > 1600) {
		image = image.resize({ height: 1600 })
	}
	if (image.width > 1600) {
		image = image.resize({ width: 1600 })
	}

	// Convert to webp and upload
	const blob = await image.toBlob("image/webp")
	const { data, error } = await supabase.storage
		.from("images")
		.upload(newFilename, blob, { upsert: uploadConfig.overwriteFiles })

	if (error) {
		console.error(
			`Got error with message "${error.message}" when trying to upload file "${filename}". Skipping...`
		)
		return undefined
	} else if (!data) {
		console.error(
			`Found file "${filename}" but received no data when requesting it from Storage. Skipping...`
		)
		return undefined
	}

	console.log(`Successfully uploaded file ${newFilename}`)
	const urlData = supabase.storage.from("images").getPublicUrl(data.path)
	const url = urlData.data.publicUrl

	return url
}

function handleNoteTransclusion(
	realName: string,
	altName: string | undefined,
	notes: Note[]
): string {
	// TODO: Add handling for #header links
	const refNote = findReferencedNote(realName, notes)

	if (refNote) {
		return `<blockquote class="blockquote not-italic"><h1 class="h1">${refNote.title}</h1>
        
        <div class="space-y-2">${refNote.content}</div></blockquote>`
	} else {
		console.warn(
			`Could not find note "${realName}". If this note doesn't yet exist, this is expected`
		)
		return altName ?? realName
	}
}

function handleNoteReference(
	realName: string,
	altName: string | undefined,
	note: Note,
	notes: Note[]
): string {
	// TODO: Add handling for #header links
	const refNote = findReferencedNote(realName, notes)

	if (refNote) {
		if (
			!backrefAlreadyExists(note.title, note.slug, refNote.backreferences)
		) {
			refNote.backreferences.push({
				displayName: note.title,
				slug: note.slug,
			})
		}
	} else {
		// console.warn(
		// 	`Could not find note "${realName}". If this note doesn't yet exist, this is expected`
		// )
		return altName ?? realName
	}

	note.references.add(refNote.slug)
	return `<a href="/${refNote.slug}" class="anchor popup">${
		altName ?? realName
	}</a>`
}

async function handleFile(
	filename: string,
	displayOptions: string | undefined,
	localMedia: TFile[],
	vault: Vault,
	supabase: SupabaseClient,
	transclude: boolean,
): Promise<string> {
	// Grab the media file from the vault, if it exists. If it doesn't, it might not be a problem
	const refFile = localMedia.find((file) => file.name === filename)

	if (!refFile) {
		// console.warn(
		// 	`Could not find file "${filename}". If this file doesn't yet exist, this is expected`
		// )
		return `[${filename}]`
	}

	// Differentiate the file type
	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]
	if (imageExtensions.includes(refFile.extension)) {
		// Parse the display options for width and height
		let width: number | undefined
		// let height: number | undefined
		if (displayOptions) {
			const resolution = displayOptions?.match(/(\d+)x?(\d+)?/) ?? [
				"",
				"",
				"",
			]
			width = resolution[1] ? parseInt(resolution[1]) : undefined
			// height = resolution[2] ? parseInt(resolution[2]) : undefined
		}

		// Load the file as a binary ArrayBuffer and upload it
		const refFileBinary = await vault.readBinary(refFile)
		const url = await uploadImage(refFileBinary, filename, supabase)

		if (transclude) {	
			const wClass = width ? findClosestWidthClass(width) : ""
			return `<img src="${url}" alt="${refFile.basename}" class="${wClass} mx-auto" />`
		} else {
			return `<a href="${url}" class="anchor">${filename}</a>`
		}
	} else {
		console.warn(
			`File type for file "${filename}" is currently unsupported. Skipping...`
		)
		return `[${filename}]`
	}
}

async function subWikilinks(
	captureGroups: (string | undefined)[],
	note: Note,
	notes: Note[],
	localMedia: TFile[],
	vault: Vault,
	supabase: SupabaseClient
): Promise<string> {
	// Note references are changed to <a> tags
	// File references are removed, leaving just the filename
	// Note transclusions copypaste the transcluded text in a <blockquote>
	// File transclusions inject the file in a tag dependent on the file type

	const isTransclusion = captureGroups[0] ? true : false
	const isMedia = captureGroups[1]?.match(/\..*$/) ? true : false

	const capture1 = captureGroups[1]
	const capture2 = captureGroups[2]

	if (!capture1) {
		console.warn(`Could not find match for note ${note.title}`)
		return note.title
	}

	if (isTransclusion && isMedia) {
		return await handleFile(
			capture1,
			capture2,
			localMedia,
			vault,
			supabase,
			true // transclude
		)
	} else if (isTransclusion && !isMedia) {
		return handleNoteTransclusion(capture1, capture2, notes)
	} else if (!isTransclusion && isMedia) {
		return await handleFile(
			capture1,
			capture2,
			localMedia,
			vault,
			supabase,
			false // reference
		)
	} else {
		return handleNoteReference(capture1, capture2, note, notes)
	}
}

function captionImages(html: string): string {
	return html.replace(
		/<img src="(.*?)" alt="(.*?)" class="(w-.*?)?\s(.*?)" \/>\s*<em>Caption:\s*(.*?)<\/em>/,
		(match, ...groups) => {
			const maxw = groups[2] ? ` max-${groups[2]}` : ""
			return `<figure class="text-center mx-auto w-fit${maxw}">\
<img src="${groups[0]}" alt="${groups[1]}" class="${groups[2]}${groups[3]}" />\
<figcaption class="text-surface-700-200-token py-2 px-4 card variant-outline-surface">\
${groups[4]}\
</figcaption>\
</figure>`
		}
	)
}

export async function convertWikilinks(
	note: Note,
	notes: Note[],
	localMedia: TFile[],
	vault: Vault,
	supabase: SupabaseClient
): Promise<Note> {
	const wikilinkRegex = /(!)?\[\[(.*?)(?:\|(.*?)?)?\]\]/g
	let matches = [...note.content.matchAll(wikilinkRegex)]

	const replacements = await Promise.all(
		matches.map((match) =>
			subWikilinks(match.slice(1), note, notes, localMedia, vault, supabase)
		)
	)

	for (const index in matches) {
		note.content = note.content.replace(
			matches[index][0],
			replacements[index]
		)
	}

	for (const [key, value] of note.details.entries()) {
		matches = [...value.matchAll(wikilinkRegex)]

		const replacements = await Promise.all(
			matches.map((match) =>
				subWikilinks(
					match.slice(1),
					note,
					notes,
					localMedia,
					vault,
					supabase
				)
			)
		)

		for (const index in matches) {
			note.details.set(
				key,
				value.replace(matches[index][0], replacements[index])
			)
		}
	}

	note.content = captionImages(note.content)

	return note
}
