import Image from "image-js"
import { localMedia, supabaseMedia, uploadConfig } from "../config"
import { joinChunks, slugPath } from "../utils"
import { Backreference, ContentChunk, Detail, Note, Wikilink } from "./types"
import { globalVault, supabase } from "main"

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
		refNote = notes.find((note) => note.slug === slugPath(noteName))
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
	fullres = false
): Promise<string | undefined> {
	// Change the extension to webp before conversion
	const newFilename = filename.replace(/\..*$/, ".webp")

	if (!uploadConfig.overwriteFiles) {
		// Check if the file already exists
		const storedFile = supabaseMedia.files.find(
			(name) => name === newFilename
		)

		// If it exists, avoid attempting a new upload and just get the URL instead
		if (storedFile) {
			const urlData = supabase.storage
				.from("images")
				.getPublicUrl(storedFile)

			return urlData.data.publicUrl
		}
	}

	// Push to the (local) list of stored files
	supabaseMedia.files.push(newFilename)

	// If it doesn't exists, load the image to manipulate it
	let image = await Image.load(fileBuffer)

	if (!fullres) {
		// Compress the image if it's overly large
		if (image.height > 1600) {
			image = image.resize({ height: 1600 })
		}
		if (image.width > 1600) {
			image = image.resize({ width: 1600 })
		}
	}

	// Convert to webp and upload
	const blob = await image.toBlob("image/webp", 85)
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

function handleNoteTransclusion(wl: Wikilink, notes: Note[]) {
	const refNote = findReferencedNote(wl.title, notes)

	if (!refNote) {
		console.warn(
			`Could not find note "${wl.title}". If this note doesn't yet exist, this is expected`
		)
		return { replacement: wl.title, allowed_users: [] }
	}

	let refTitle = ""
	let refContent = ""
	let allowedUsers: string[] = []
	// TODO: Add handling of block references
	if (wl.header && !wl.isBlockRef) {
		// If the transclusion is only for a single section, grab it in the correct chunk
		for (const chunk of refNote.content) {
			const headerSlug = slugPath(wl.header)
			// This matches only if there is another header after the section, which means the last section is ignored
			const match = chunk.text.match(
				new RegExp(
					`<h\\d[^\\n]*?id="${headerSlug}".*?>.*?</h\\d>\\s*(.*?)(?=<h\\d)`,
					"s"
				)
			)
			if (match) {
				refTitle = wl.altName ?? wl.header
				refContent = match[1]
				allowedUsers = chunk.allowed_users
				break
			}

			// This instead matches until the end-of-file, which is used for the last section only
			const matchTillEOF = chunk.text.match(
				new RegExp(
					`<h\\d[^\\n]*?id="${headerSlug}".*?>.*?</h\\d>\\s*(.*?)$(?![\r\n])`,
					"s"
				)
			)
			if (matchTillEOF) {
				refTitle = wl.altName ?? wl.header
				refContent = matchTillEOF[1]
				allowedUsers = chunk.allowed_users
				break
			}
		}

		// If the header can't be found for some reason, just transclude the whole thing as a fallback
		if (!refContent) {
			console.warn(
				`Could not find header ${wl.header} in note ${wl.title}`
			)
			refTitle = wl.altName ?? refNote.properties.alt_title ?? wl.title
			refContent = joinChunks(refNote.content)
			allowedUsers = refNote.properties.allowed_users
		}
	} else {
		// Otherwise grab the entire note
		refTitle = wl.altName ?? refNote.properties.alt_title ?? wl.title
		refContent = joinChunks(refNote.content)
		allowedUsers = refNote.properties.allowed_users
	}

	return {
		replacement: `<blockquote class="blockquote not-italic"><h2 class="h2">${refTitle}</h2>
	
	<div class="space-y-2">${refContent}</div></blockquote>`,
		allowed_users: allowedUsers,
	}
}

function handleNoteReference(wl: Wikilink, note: Note, notes: Note[]): string {
	const refNote = findReferencedNote(wl.title, notes)

	if (!refNote) {
		return wl.altName ?? wl.title
	}

	const thisName = note.properties.alt_title ?? note.title
	const refName = wl.altName ?? refNote.properties.alt_title ?? wl.title

	if (!backrefAlreadyExists(thisName, note.slug, refNote.backreferences)) {
		refNote.backreferences.push({
			displayName: thisName,
			slug: note.slug,
		})
	}

	note.references.add(refNote.slug)

	// TODO: Add handling of block references
	const headerLink =
		wl.header && !wl.isBlockRef ? `#${slugPath(wl.header)}` : ""
	return `<a href="/${refNote.slug}${headerLink}" class="anchor popup">${refName}</a>`
}

async function handleFile(
	filename: string,
	displayOptions: string | undefined,
	transclude: boolean
): Promise<string> {
	// Grab the media file from the vault, if it exists. If it doesn't, it might not be a problem
	const refFile = localMedia.files.find((file) => file.name === filename)

	if (!refFile) {
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
		const refFileBinary = await globalVault.readBinary(refFile)
		const url = await uploadImage(refFileBinary, filename, true)

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

async function getReferenceReplacements(
	wikilink: Wikilink,
	note: Note,
	notes: Note[]
): Promise<string> {
	// Note references are changed to <a> tags
	// File references are removed, leaving just the filename with a link to the file
	if (!wikilink.title) {
		console.warn(`Could not find match for note ${note.title}`)
		return note.title
	}

	if (wikilink.isMedia) {
		return await handleFile(wikilink.title, wikilink.altName, false)
	} else {
		return handleNoteReference(wikilink, note, notes)
	}
}

async function getTransclusionReplacements(
	wikilink: Wikilink,
	note: Note,
	notes: Note[]
) {
	// Note transclusions copypaste the transcluded text in a <blockquote>
	// File transclusions inject the file in a tag dependent on the file type

	if (!wikilink.title) {
		console.warn(`Could not find match for note ${note.title}`)
		return { replacement: note.title, type: "error", allowed_users: [] }
	}

	if (wikilink.isMedia) {
		return {
			replacement: await handleFile(
				wikilink.title,
				wikilink.altName,
				true
			),
			type: "file",
			allowed_users: [],
		}
	} else {
		return {
			type: "note",
			...handleNoteTransclusion(wikilink, notes),
		}
	}
}

function captionImages(html: string): string {
	return html.replace(
		/<img src="(.*?)" alt="(.*?)" class="(w-.*?)?\s(.*?)" \/>\s*<em>Caption:\s*(.*?)<\/em>/,
		(match, ...groups) => {
			const maxw = groups[2] ? ` max-${groups[2]}` : ""
			return `<figure class="text-center mx-auto w-fit${maxw}">\
<img src="${groups[0]}" alt="${groups[1]}" class="${groups[2]} ${groups[3]}" />\
<figcaption class="text-surface-700-200-token py-2 px-4 card variant-outline-surface">\
${groups[4]}\
</figcaption>\
</figure>`
		}
	)
}

function matchWikilinks(text: string) {
	const wikilinkRegex = /(!)?\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g
	const matches = [...text.matchAll(wikilinkRegex)]

	const wikilinks: Wikilink[] = []
	for (const match of matches) {
		const wikilink: Wikilink = {
			isTransclusion: false,
			isBlockRef: false,
			isMedia: false,
			fullLink: "",
			title: "",
			header: undefined,
			altName: undefined,
		}

		wikilink.fullLink = match[0]

		if (match[1]) wikilink.isTransclusion = true

		wikilink.title = match[2]

		if (match[2].match(/\.\w+$/)) wikilink.isMedia = true

		if (match[3]) {
			if (match[3].startsWith("#^")) {
				wikilink.isBlockRef = true
				wikilink.header = match[3].replace("#^", "")
			} else {
				wikilink.header = match[3].replace("#", "")
			}
		}

		if (match[4]) wikilink.altName = match[4].replace("|", "")

		wikilinks.push(wikilink)
	}

	return wikilinks
}

function removeCode(text: string) {
	const inlineCodeRegex = /<code.*?>.*?<\/code>/gm
	const codeBlockRegex = /<pre class="codeblock-pre">.*?<\/pre>/gs

	const inlineCode = Array.from(text.matchAll(inlineCodeRegex)).map(
		(match) => match[0]
	)
	const codeBlocks = Array.from(text.matchAll(codeBlockRegex)).map(
		(match) => match[0]
	)

	let counterInline = 0
	let counterBlock = 0
	const filteredText = text
		.replace(inlineCodeRegex, () => {
			counterInline += 1
			return `<|inline_code_${counterInline}|>`
		})
		.replace(codeBlockRegex, () => {
			counterBlock += 1
			return `<|codeblock_${counterBlock}|>`
		})

	return {
		inlineCode,
		codeBlocks,
		filteredText,
	}
}

function addCodeBack(
	text: string,
	inlineCode: string[],
	codeBlocks: string[]
): string {
	return text
		.replace(
			/<\|inline_code_(\d+)\|>/g,
			(_match, index) => inlineCode[index - 1]
		)
		.replace(
			/<\|codeblock_(\d+)\|>/g,
			(_match, index) => codeBlocks[index - 1]
		)
}

export async function convertWikilinks(notes: Note[]): Promise<Note[]> {
	const convertedNotes: Note[] = []

	for (const note of notes) {
		for (const chunk of note.content) {
			// Remove code blocks to avoid matching links in them
			const out = removeCode(chunk.text)
			chunk.text = out.filteredText

			// First, handle the references
			// Find all the references
			const references = matchWikilinks(chunk.text).filter(
				(wl) => !wl.isTransclusion
			)

			// then get their replacements
			const refReplacements = await Promise.all(
				references.map((ref) =>
					getReferenceReplacements(ref, note, notes)
				)
			)

			// and finally actually replace them
			for (const index in references) {
				chunk.text = chunk.text.replace(
					references[index].fullLink,
					refReplacements[index]
				)
			}

			chunk.text = addCodeBack(chunk.text, out.inlineCode, out.codeBlocks)
		}
	}

	for (const note of notes) {
		for (const chunk of note.content) {
			// Then, handle the transclusions. Using a separate loop guarantees
			// that the transcluded pages will have all references already converted
			// FIXME: There's still probably issues with unconverted transclusions, especially
			// between pages that transclude each other

			// Remove code blocks to avoid matching links in them
			const out = removeCode(chunk.text)
			chunk.text = out.filteredText

			const transclusions = matchWikilinks(chunk.text).filter(
				(wl) => wl.isTransclusion
			)

			const transReplacements = await Promise.all(
				transclusions.map((trans) =>
					getTransclusionReplacements(trans, note, notes)
				)
			)

			for (const index in transclusions) {
				if (transReplacements[index].type === "note") {
					// TODO: Add transclusion authorization
					const parts = chunk.text.split(
						transclusions[index].fullLink
					)
					if (parts.length === 1) continue

					const partObj = parts.map((p) => {
						return {
							text: p,
							allowed_users: chunk.allowed_users,
						}
					})
					partObj.splice(1, 0, {
						text: transReplacements[index].replacement,
						allowed_users: transReplacements[index].allowed_users,
					})

					for (const i in partObj) {
						const index = parseInt(i)
						const newChunk: ContentChunk = {
							chunk_id: 1,
							...partObj[index],
						}
						note.content.splice(
							chunk.chunk_id - 1 + index,
							1,
							newChunk
						)
					}
				} else {
					chunk.text = chunk.text.replace(
						transclusions[index].fullLink,
						transReplacements[index].replacement
					)
				}
			}

			// Theoretically, iterating over all chunks should cause problems as your are adding code
			// blocks to chunks that have yet to be formatted. However, this appears to work just fine.
			// I have absolutely no clue why, but I'm not gonna be the one to question miracles.
			for (const chunk of note.content) {
				chunk.text = addCodeBack(
					chunk.text,
					out.inlineCode,
					out.codeBlocks
				)
				chunk.text = captionImages(chunk.text)
			}
		}

		// Renumber chunks after potentially splicing them, knowing that the array order is correct
		note.content.forEach((chunk, index) => (chunk.chunk_id = index + 1))

		// Then, replace references in the details. Details should not have transclusion
		// because they don't fit in the UI
		const newDetails: Detail[] = []
		for (const detail of note.details) {
			const detailLinks = matchWikilinks(detail.value).filter(
				(wl) => !wl.isTransclusion
			)

			const detailReplacements = await Promise.all(
				detailLinks.map((ref) =>
					getReferenceReplacements(ref, note, notes)
				)
			)

			let replaced = detail.value
			for (const index in detailLinks) {
				replaced = replaced.replace(
					detailLinks[index].fullLink,
					detailReplacements[index]
				)
			}
			newDetails.push({ ...detail, value: replaced })
		}
		note.details = newDetails

		convertedNotes.push(note)
	}

	return convertedNotes
}
