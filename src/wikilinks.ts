import { Notice, TFile, Vault } from "obsidian"
import { Backreference, Note, slugifyPath } from "./format"
import { SupabaseClient } from "@supabase/supabase-js"
import { FileObject } from "@supabase/storage-js"
import Image from "image-js"

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
		console.warn(
			`Could not find note "${realName}". If this note doesn't yet exist, this is expected`
		)
		return altName ?? realName
	}

	note.references.add(refNote.slug)
	return `<a href="/${refNote.slug}" class="anchor">${
		altName ?? realName
	}</a>`
}

async function handleFileTransclusion(
	filename: string,
	displayOptions: string | undefined,
	media: TFile[],
	vault: Vault,
	filesInStorage: FileObject[],
	supabase: SupabaseClient
): Promise<string> {
	const refFile = media.find((file) => file.name === filename)

	let width: number | undefined
	let height: number | undefined
	if (displayOptions) {
		const resolution = displayOptions?.match(/(\d+)x?(\d+)?/) ?? ["", "", ""]
		width = resolution[1] ? parseInt(resolution[1]) : undefined
		height = resolution[2] ? parseInt(resolution[2]) : undefined
	}

	if (!refFile) {
		console.warn(
			`Could not find file "${filename}". If this file doesn't yet exist, this is expected`
		)
		return `[${filename}]`
	}

	let fileType: string
	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]
	if (imageExtensions.includes(refFile.extension)) {
		fileType = "image"
	} else {
		console.warn(
			`File type for file "${filename}" is currently unsupported. Skipping...`
		)
		return `[${filename}]`
	}

	const refFileBinary = await vault.readBinary(refFile)
	const image = await Image.load(refFileBinary)	

	// If the user specified width or height, rewrite the filename to {filename}_{w}x{h}.webp
	filename = refFile.basename
	// if (image.size > 1280 * 720) { filename += `_720` }
	filename += ".webp"

	const storedFile = filesInStorage.find((file) => file.name === filename)
	let url: string

	if (!storedFile) {
		// Resize image if necessary
		// if (width) {
		// 	image = height
		// 		? image.resize({ width: width, height: height })
		// 		: image.resize({ width: width })
		// }
		
		// Convert to webp
		const blob = await image.toBlob('image/webp')
		const { data, error } = await supabase.storage
			.from("images")
			.upload(filename, blob)

		if (error) {
			console.error(
				`Got error with message "${error.message}" when trying to upload file "${filename}". Skipping...`
			)
			return `[${filename}]`
		} else if (!data) {
			console.error(
				`Found file "${filename}" but received no data when requesting it from Storage. Skipping...`
			)
			return `[${filename}]`
		}

		new Notice(`Successfully uploaded file ${filename} as ${data?.path}`)
		console.log(`Successfully uploaded file ${filename} as ${data?.path}`)
		const urlData = supabase.storage.from("images").getPublicUrl(data.path)

		url = urlData.data.publicUrl
	} else {
		console.log(`Found existing file ${storedFile.name}`)
		const urlData = supabase.storage
			.from("images")
			.getPublicUrl(storedFile.name)

		url = urlData.data.publicUrl
	}

	let tag: string
	const wClass = width ? `w-[${width}px]` : ""
	const hClass = height ? `h-[${height}px]` : ""
	switch (fileType) {
		case "image":
			tag = `<img src="${url}" alt="${refFile.basename}" class="${wClass} ${hClass} mx-auto" />`
			return tag
		default:
			// This should be impossible, it's here just because TypeScript is complaining
			return `[${filename}]`
	}
}

async function subWikilinks(
	match: string,
	captureGroups: (string | undefined)[],
	note: Note,
	notes: Note[],
	media: TFile[],
	vault: Vault,
	filesInStorage: FileObject[],
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
		return await handleFileTransclusion(
			capture1,
			capture2,
			media,
			vault,
			filesInStorage,
			supabase
		)
	} else if (isTransclusion && !isMedia) {
		return handleNoteTransclusion(capture1, capture2, notes)
	} else if (!isTransclusion && isMedia) {
		return capture2 ?? capture1
		// handleFileReference()
	} else {
		return handleNoteReference(capture1, capture2, note, notes)
	}
}

function captionImages(html: string): string {
	return html.replace(
		/<img src="(.*?)" alt="(.*?)" class="(w-\[.*?\])?(.*?)" \/>\s*<em>Caption:\s*(.*?)<\/em>/,
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
	media: TFile[],
	vault: Vault,
	filesInStorage: FileObject[],
	supabase: SupabaseClient
): Promise<Note> {
	const wikilinkRegex = /(!)?\[\[(.*?)(?:\|(.*?)?)?\]\]/g
	let matches = [...note.content.matchAll(wikilinkRegex)]

	const replacements = await Promise.all(
		matches.map((match) =>
			subWikilinks(
				match[0],
				match.slice(1),
				note,
				notes,
				media,
				vault,
				filesInStorage,
				supabase
			)
		)
	)

	let newContent = note.content
	for (const index in matches) {
		newContent = newContent.replace(matches[index][0], replacements[index])
	}
	note.content = newContent

	for (const [key, value] of note.details.entries()) {
		matches = [...value.matchAll(wikilinkRegex)]

		const replacements = await Promise.all(
			matches.map((match) =>
				subWikilinks(
					match[0],
					match.slice(1),
					note,
					notes,
					media,
					vault,
					filesInStorage,
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
