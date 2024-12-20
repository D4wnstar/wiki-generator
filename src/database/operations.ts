import { Client } from "@libsql/client"
import { Database } from "sql.js"
import { Pages, User } from "src/database/types"
import { WikiGeneratorSettings } from "src/settings"

const createNotes = `
CREATE TABLE IF NOT EXISTS notes (
	id INTEGER PRIMARY KEY,
	title TEXT NOT NULL,
	alt_title TEXT,
	path TEXT UNIQUE NOT NULL,
	slug TEXT UNIQUE NOT NULL,
	frontpage BOOLEAN DEFAULT FALSE,
	lead TEXT NOT NULL,
	allowed_users TEXT
);`

const createImages = `
CREATE TABLE IF NOT EXISTS images (
	id INTEGER PRIMARY KEY,
	blob BLOB NOT NULL,
	alt TEXT
);`

const createNoteContents = `
CREATE TABLE IF NOT EXISTS note_contents (
	note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	chunk_id INTEGER NOT NULL,
	"text" TEXT NOT NULL,
	allowed_users TEXT,
	image_id INTEGER REFERENCES images (id) ON DELETE CASCADE,
	PRIMARY KEY (note_id, chunk_id)
);`

const createDetails = `
CREATE TABLE IF NOT EXISTS details (
	note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	"order" INTEGER NOT NULL,
	detail_name TEXT NOT NULL,
	detail_content TEXT,
	PRIMARY KEY (note_id, detail_name)
);`

const createSidebarImages = `
CREATE TABLE IF NOT EXISTS sidebar_images (
	note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	"order" INTEGER NOT NULL,
	image_name TEXT NOT NULL,
	image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE,
	caption TEXT,
	PRIMARY KEY (note_id, image_name)
);`

const createWikiSettings = `
CREATE TABLE IF NOT EXISTS wiki_settings (
	id INTEGER PRIMARY KEY,
	title TEXT NOT NULL,
	allow_logins BOOLEAN NOT NULL
);`

const createUsers = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	password TEXT NOT NULL
);`

const deleteNotes = `DROP TABLE IF EXISTS notes;`
const deleteImages = `DROP TABLE IF EXISTS images;`
const deleteNoteContents = `DROP TABLE IF EXISTS note_contents;`
const deleteDetails = `DROP TABLE IF EXISTS details;`
const deleteSidebarImages = `DROP TABLE IF EXISTS sidebar_images;`
const deleteWikiSettings = `DROP TABLE IF EXISTS wiki_settings;`
// const deleteUsers = `DROP TABLE IF EXISTS users;`

export async function runRemoteMigrations(client: Client) {
	await client.execute(createNotes)
	await client.execute(createImages)
	await client.execute(createNoteContents)
	await client.execute(createDetails)
	await client.execute(createSidebarImages)
	await client.execute(createWikiSettings)
	await client.execute(createUsers)
}

export async function clearRemoteDatabase(client: Client) {
	await client.execute(deleteNotes)
	await client.execute(deleteImages)
	await client.execute(deleteNoteContents)
	await client.execute(deleteDetails)
	await client.execute(deleteSidebarImages)
	await client.execute(deleteWikiSettings)
}

export function runLocalMigrations(db: Database) {
	db.run(createNotes)
	db.run(createImages)
	db.run(createNoteContents)
	db.run(createDetails)
	db.run(createSidebarImages)
	db.run(createWikiSettings)
	db.run(createUsers)
}

export function insertUsers(users: User[], db: Database) {
	for (const user of users) {
		db.run(
			`
			INSERT OR REPLACE INTO users (id, username, password)
			VALUES (?, ?, ?);
		`,
			[user.id, user.username, user.password]
		)
	}
}

const insertImage = `INSERT INTO images (blob, alt) VALUES (?, ?) RETURNING id;`

export function insertImageLocal(
	imageName: string,
	buf: ArrayBuffer,
	db: Database
) {
	const U8Arr = new Uint8Array(buf)
	const rows = db.exec(insertImage, [U8Arr, imageName])
	return rows[0].values[0][0] as number // image id
}

export async function insertImageRemote(
	imageName: string,
	buf: ArrayBuffer,
	client: Client
) {
	const res = await client.execute({
		sql: insertImage,
		args: [buf, imageName],
	})
	return res.rows[0].id as number
}

const insertNotes = `
INSERT INTO notes (
	id,
	title,
	alt_title,
	path,
	slug,
	frontpage,
	lead,
	allowed_users
) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`

const insertNoteContents = `
INSERT INTO note_contents (
	note_id,
	chunk_id,
	"text",
	allowed_users,
	image_id
) VALUES (?, ?, ?, ?, ?);`

const insertDetails = `
INSERT INTO details (
	note_id,
	"order",
	detail_name,
	detail_content
) VALUES (?, ?, ?, ?);`

const insertSidebarImages = `
INSERT INTO sidebar_images (
	note_id,
	"order",
	image_name,
	image_id,
	caption
) VALUES (?, ?, ?, ?, ?);`

const insertWikiSettings = `
INSERT INTO wiki_settings (
	title,
	allow_logins
) VALUES (?, ?);`

export async function pushPagesToRemote(
	client: Client,
	pages: Pages,
	settings: WikiGeneratorSettings
) {
	const noteQueries = []
	const noteContentsQueries = []
	const detailsQueries = []
	const sidebarImagesQueries = []

	for (const [noteId, page] of pages.entries()) {
		noteQueries.push({
			sql: insertNotes,
			args: [
				noteId,
				page.note.title,
				page.note.alt_title,
				page.note.path,
				page.note.slug,
				page.note.frontpage,
				page.note.lead,
				page.note.allowed_users,
			],
		})

		for (const chunk of page.chunks) {
			noteContentsQueries.push({
				sql: insertNoteContents,
				args: [
					noteId,
					chunk.chunk_id,
					chunk.text,
					chunk.allowed_users,
					chunk.image_id,
				],
			})
		}

		for (const detail of page.details) {
			detailsQueries.push({
				sql: insertDetails,
				args: [noteId, detail.order, detail.key, detail.value],
			})
		}

		for (const img of page.sidebarImages) {
			sidebarImagesQueries.push({
				sql: insertSidebarImages,
				args: [
					noteId,
					img.order,
					img.image_name,
					img.image_id,
					img.caption,
				],
			})
		}
	}

	await client.batch(noteQueries)
	await client.batch(noteContentsQueries)
	await client.batch(detailsQueries)
	await client.batch(sidebarImagesQueries)
	await client.execute({
		sql: insertWikiSettings,
		args: [settings.wikiTitle, settings.allowLogins ? 1 : 0],
	})
}

export function pushPagesToLocal(
	db: Database,
	pages: Pages,
	settings: WikiGeneratorSettings
) {
	for (const [noteId, page] of pages.entries()) {
		db.run(insertNotes, [
			noteId,
			page.note.title,
			page.note.alt_title,
			page.note.path,
			page.note.slug,
			page.note.frontpage,
			page.note.lead,
			page.note.allowed_users,
		])

		for (const chunk of page.chunks) {
			db.run(insertNoteContents, [
				noteId,
				chunk.chunk_id,
				chunk.text,
				chunk.allowed_users,
				chunk.image_id,
			])
		}

		for (const detail of page.details) {
			db.run(insertDetails, [
				noteId,
				detail.order,
				detail.key,
				detail.value,
			])
		}

		for (const img of page.sidebarImages) {
			db.run(insertSidebarImages, [
				noteId,
				img.order,
				img.image_name,
				img.image_id,
				img.caption,
			])
		}
	}

	db.run(insertWikiSettings, [
		settings.wikiTitle,
		settings.allowLogins ? 1 : 0,
	])
}
