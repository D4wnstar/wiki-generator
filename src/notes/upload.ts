import { supabase } from "main"
import markdownit from "markdown-it"
import { Notice, request } from "obsidian"
import { supabaseMedia, localMedia } from "src/config"
import { setupMediaBucket } from "src/database/init"
import { vaultToNotes } from "./format"
import { DatabaseError, DatabaseNote, FrontPageError, Note } from "./types"
import { convertWikilinks } from "./wikilinks"
import { getFilesInStorage } from "src/database/requests"

export async function convertNotesAndUpload(
	deployHookUrl: string | undefined
): Promise<void> {
	const converter = markdownit({ html: true })

	await setupMediaBucket()

	// Fetch a list of media files in the remote database and
	// store those files globally (see supabaseMedia comment for why)
	const mediaInStorage = await getFilesInStorage(supabase)
	supabaseMedia.files = mediaInStorage.map((file) => file.name)

	// Grab all the files, parse all markdown for custom syntax and upload sidebar images
	console.log("Fetching files from vault...")
	const [allNotes, mediaInVault] = await vaultToNotes(converter)

	// Store local files globally (same reasoning as supabaseMedia)
	localMedia.files = mediaInVault

	// Remove all notes that aren't set to be published
	let notes = allNotes.filter((note) => note.properties.publish)

	checkFrontpageUniqueness(notes)

	// Convert all the [[wikilinks]] in the notes
	console.log("Converting notes...")
	new Notice("Converting notes...")
	notes = await convertWikilinks(notes)
	notes.sort((a, b) => a.slug.localeCompare(b.slug))

	console.log("Inserting content into Supabase. This might take a while...")
	new Notice("Inserting content into Supabase. This might take a while...")
	const uploadedNotes = await uploadNotes(notes)
	await uploadExtraInfo(notes, uploadedNotes)

	// NOTE: Currently, all the notes are deleted every time the user uploads their notes.
	// It's a little inefficient, as it's a lot of technically unnecessary DELETE and INSERT
	// operations, but since all relevant tables are ON DELETE CASCADE, deleting the notes
	// guarantees effortless database synchronization. Manually updating and deleting orphan
	// references based on which notes were deleted is probably more efficient, but not enough
	// to justify pursuing this method, considering how many problems it showed during previous
	// development. Old deletion code is probably going to remain here just in case.

	// Clean up remote notes by removing ones that have been deleted or set to unpublished locally
	// const notesToDelete = await getNotesToDelete(notes)

	// if (notesToDelete.length > 0) {
	// 	console.log("Syncing notes...")
	// 	new Notice("Syncing notes...")
	// 	const deletedNotes = await deleteUnusedNotes(notesToDelete)

	// 	if (deletedNotes.length > 0) {
	// 		console.log(
	// 			`Deleted the following notes to keep the database synchronized: ${deletedNotes.map(
	// 				(note) => note.slug
	// 			)}`
	// 		)
	// 	}
	// }

	// Clean up remote files by removing ones that have been deleted locally
	// TODO: Also remove files that are no longer referenced by any note
	const localMediaCorrectExt = localMedia.files.map((file) =>
		file.name.replace(/\..*$/, ".webp")
	)
	await deleteUnusedMedia(localMediaCorrectExt)
}

function checkFrontpageUniqueness(notes: Note[]) {
	const frontpageArray = notes.filter((note) => note.properties.frontpage)
	if (frontpageArray.length === 0) {
		throw new FrontPageError(
			"ERROR: No page has been set as the front page. One front page must be set by adding the wiki-home: true property to a note."
		)
	} else if (frontpageArray.length > 1) {
		throw new FrontPageError(
			`ERROR: Multiple pages have been set as the front page.
			Please only set a single page as the front page.
			The relevant pages are ${frontpageArray.reduce(
				(prev, curr) => `${prev}\n${curr.path}`,
				"\n"
			)}`
		)
	}
}

async function uploadNotes(notes: Note[]) {
	const { error: nukeError } = await supabase
		.from('notes')
		.delete()
		.gt('id', 0)

	if (nukeError) throw new DatabaseError(nukeError.message)

	const { data: uploadedNotes, error } = await supabase
		.from("notes")
		.upsert(
			notes.map((note) => {
				return {
					title: note.title,
					alt_title: note.properties.alt_title,
					path: note.path,
					lead: note.lead,
					slug: note.slug,
					frontpage: note.properties.frontpage,
					references: [...note.references],
					allowed_users: note.properties.allowed_users,
				}
			}),
			{
				onConflict: "slug", // Treat rows with the same slug as duplicate pages
				ignoreDuplicates: false, // Merge information of duplicate pages to keep things updated
			}
		)
		.select()

	if (error) {
		throw new DatabaseError(error.message)
	}

	return uploadedNotes
}

async function uploadExtraInfo(notes: Note[], uploadedNotes: DatabaseNote[]) {
	// Make an array with all contents
	const contents = notes.flatMap((note, index) => {
		return note.content.map((chunk) => {
			return {
				note_id: uploadedNotes[index].id,
				...chunk,
			}
		})
	})

	const { error: contentError } = await supabase
		.from("note_contents")
		.upsert(contents)

	if (contentError) throw new DatabaseError(contentError.message)

	// Make an array with all details
	const details = notes.flatMap((note, index) => {
		return [...note.details.entries()].map((pair) => {
			return {
				note_id: uploadedNotes[index].id,
				detail_name: pair[0],
				detail_content: pair[1],
			}
		})
	})

	const { error: detailsError } = await supabase
		.from("details")
		.upsert(details)

	if (detailsError) throw new DatabaseError(detailsError.message)

	// Make an array with all backreferences
	const backreferences = notes.flatMap((note, index) => {
		return note.backreferences.map((backref) => {
			return {
				note_id: uploadedNotes[index].id,
				display_name: backref.displayName,
				slug: backref.slug,
			}
		})
	})

	const { error: backrefError } = await supabase
		.from("backreferences")
		.upsert(backreferences)

	if (backrefError) throw new DatabaseError(backrefError.message)

	// Make an array with all images
	const images = notes.flatMap((note, index) => {
		return note.sidebarImages.map((img) => {
			return {
				note_id: uploadedNotes[index].id,
				image_name: img.image_name,
				url: img.url,
				caption: img.caption,
			}
		})
	})
	const { error: imagesError } = await supabase
		.from("sidebar_images")
		.upsert(images)

	if (imagesError) throw new DatabaseError(imagesError.message)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getNotesToDelete(notes: Note[]) {
	const notesToDelete = []
	const { data: storedNotes, error: retrievalError } = await supabase.from(
		"notes"
	).select(`
            *,
            note_contents (*),
            backreferences (*),
            details (*),
            sidebar_images (*)
        `)

	if (retrievalError) throw new DatabaseError(retrievalError.message)

	// Choose notes to delete based on whether they exists remotely but not locally
	for (const remoteNote of storedNotes) {
		if (!notes.find((localNote) => localNote.title === remoteNote.title)) {
			notesToDelete.push(remoteNote)
		}
	}

	return notesToDelete
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function deleteUnusedNotes(notesToDelete: DatabaseNote[]) {
	const slugsToDelete = notesToDelete.map((note) => note.slug)
	const idsToDelete = notesToDelete.map((note) => note.id)

	// Delete all details with matching id...
	const { error: detailsDeletionError } = await supabase
		.from("details")
		.delete()
		.in("note_id", idsToDelete)
	if (detailsDeletionError)
		throw new DatabaseError(detailsDeletionError.message)

	// ...all backreferences with matching id...
	const { error: backrefIdDeletionError } = await supabase
		.from("backreferences")
		.delete()
		.in("note_id", idsToDelete)
	if (backrefIdDeletionError)
		throw new DatabaseError(backrefIdDeletionError.message)

	// ...all backreferences with matching slug...
	const { error: backrefSlugDeletionError } = await supabase
		.from("backreferences")
		.delete()
		.in("slug", slugsToDelete)
	if (backrefSlugDeletionError)
		throw new DatabaseError(backrefSlugDeletionError.message)

	// ...and all sidebar images with matching id...
	const { error: sidebarImageDeletionError } = await supabase
		.from("sidebar_images")
		.delete()
		.in("note_id", idsToDelete)
	if (sidebarImageDeletionError)
		throw new DatabaseError(sidebarImageDeletionError.message)

	// ...and finally all notes with matching slugs
	const { data: deletedNotes, error: notesDeletionError } = await supabase
		.from("notes")
		.delete()
		.in("slug", slugsToDelete)
		.select()
	if (notesDeletionError) throw new DatabaseError(notesDeletionError.message)

	return deletedNotes
}

async function deleteUnusedMedia(localMedia: string[]) {
	const mediaToDelete: string[] = []
	for (const filename of supabaseMedia.files) {
		if (!localMedia.find((name) => name === filename)) {
			mediaToDelete.push(filename)
		}
	}

	if (mediaToDelete.length > 0) {
		console.log("Syncing media...")
		new Notice("Syncing media...")

		const { data: deletedMedia, error: deletionError } =
			await supabase.storage.from("images").remove(mediaToDelete)

		if (deletionError) throw new DatabaseError(deletionError.message)
		console.log(
			`Removed the following files to keep the database synchronized: ${deletedMedia.map(
				(file) => file.name
			)}`
		)

		const { error: dbDeletionError } = await supabase
			.from("stored_media")
			.delete()
			.in("media_name", mediaToDelete)

		if (dbDeletionError) throw new DatabaseError(dbDeletionError.message)
	}
}
