import { Notice, TFile, Vault } from "obsidian"
import { Backreference, Note, slugifyPath } from "./format"
import { SupabaseClient } from "@supabase/supabase-js"
import { FileObject } from "@supabase/storage-js"

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
	captureGroups: string[],
	notes: Note[]
): string {
	// TODO: Add handling for #header links
	const realName = captureGroups[1]
	const altName = captureGroups[2] // may be undefined

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
	captureGroups: string[],
	note: Note,
	notes: Note[]
): string {
	// TODO: Add handling for #header links
	const realName = captureGroups[1]
	const altName = captureGroups[2] // may be undefined

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
	captureGroups: string[],
	media: TFile[],
	vault: Vault,
	filesInStorage: FileObject[],
	supabase: SupabaseClient
): Promise<string> {
	const filename = captureGroups[1]
	// const displayOptions = captureGroups[2]
	const refFile = media.find((file) => file.name === filename)

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
		return filename
	}

	// Pathname check is an .includes() so that I don't have to extract the base name
	// AND because blobs have a random suffix added to their filename by default
	const storedFile = filesInStorage.find((file) =>
		file.name.includes(filename)
	)
	let url: string

	if (!storedFile) {
		const refFileBinary = await vault.readBinary(refFile)
		const { data, error } = await supabase.storage
			.from("images")
			.upload(filename, new Blob([refFileBinary]))

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

	switch (fileType) {
		case "image":
			return `<img src="${url}" alt="${refFile.basename}" />`
		default:
			// This should be impossible, it's here just because TypeScript is complaining
			return `[${filename}]`
	}
}

async function subWikilinks(
	match: string,
	captureGroups: string[],
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

	// const captureGroups: string[] = groups.slice(0, -2)
	const isTransclusion = captureGroups[0] ? true : false
	const isMedia = captureGroups[1]?.match(/\..*$/) ? true : false

	if (isTransclusion && isMedia) {
		return await handleFileTransclusion(
			captureGroups,
			media,
			vault,
			filesInStorage,
			supabase
		)
	} else if (isTransclusion && !isMedia) {
		return handleNoteTransclusion(captureGroups, notes)
	} else if (!isTransclusion && isMedia) {
		return captureGroups[1] ?? captureGroups[0]
		// handleFileReference()
	} else {
		return handleNoteReference(captureGroups, note, notes)
	}
}

export async function convertWikilinks(
	note: Note,
	notes: Note[],
	media: TFile[],
	vault: Vault,
	filesInStorage: FileObject[],
	supabase: SupabaseClient
): Promise<Note> {
	const matches = Array.from(
		note.content.matchAll(/(!)?\[\[(.*?)(?:\|(.*?)?)?\]\]/g)
	)

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

	return note
}
