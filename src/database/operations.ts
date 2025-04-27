import { Client, createClient } from "@libsql/client"
import { Database } from "sql.js"
import {
	Pages,
	User,
	DatabaseAdapter,
	Note,
	ImageData,
} from "src/database/types"
import { WikiGeneratorSettings } from "src/settings"
import { Vault } from "obsidian"
import { findFileInPlugin } from "./filesystem"

const createNotes = `
CREATE TABLE IF NOT EXISTS notes (
	path TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	alt_title TEXT,
	slug TEXT UNIQUE NOT NULL,
	frontpage BOOLEAN DEFAULT FALSE,
	lead TEXT NOT NULL,
	allowed_users TEXT,
	hash TEXT NOT NULL, -- hash is calculated BEFORE preprocessing anything!
	last_updated INTEGER NOT NULL
);`

const createImages = `
CREATE TABLE IF NOT EXISTS images (
	path TEXT PRIMARY KEY,
	blob BLOB NOT NULL,
	alt TEXT,
	hash TEXT NOT NULL,
	last_updated INTEGER NOT NULL,
	compressed BOOLEAN NOT NULL
);`

const createNoteContents = `
CREATE TABLE IF NOT EXISTS note_contents (
	note_path TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
	chunk_id INTEGER NOT NULL,
	"text" TEXT NOT NULL,
	allowed_users TEXT,
	image_path TEXT REFERENCES images (path) ON DELETE CASCADE,
	note_transclusion_path TEXT REFERENCES notes (path) ON DELETE CASCADE,
	PRIMARY KEY (note_path, chunk_id)
);`

const createDetails = `
CREATE TABLE IF NOT EXISTS details (
	note_path TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
	"order" INTEGER NOT NULL,
	detail_name TEXT NOT NULL,
	detail_content TEXT,
	PRIMARY KEY (note_path, detail_name)
);`

const createSidebarImages = `
CREATE TABLE IF NOT EXISTS sidebar_images (
	note_path TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
	"order" INTEGER NOT NULL,
	image_name TEXT NOT NULL,
	image_path TEXT NOT NULL REFERENCES images (path) ON DELETE CASCADE,
	caption TEXT,
	PRIMARY KEY (note_path, image_name)
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

const createNotesAllowedUsersIndex = `
CREATE INDEX IF NOT EXISTS idx_notes_allowed_users ON notes(allowed_users);
`

const createNoteContentsAllowedUsersIndex = `
CREATE INDEX IF NOT EXISTS idx_note_contents_allowed_users ON note_contents(allowed_users);
`

const tables = [
	{ name: "notes", schema: createNotes },
	{ name: "images", schema: createImages },
	{ name: "note_contents", schema: createNoteContents },
	{ name: "details", schema: createDetails },
	{ name: "sidebar_images", schema: createSidebarImages },
	{ name: "wiki_settings", schema: createWikiSettings },
	{ name: "users", schema: createUsers },
]

const indexes = [
	createNotesAllowedUsersIndex,
	createNoteContentsAllowedUsersIndex,
]

const deleteNotes = `DROP TABLE IF EXISTS notes;`
const deleteImages = `DROP TABLE IF EXISTS images;`
const deleteNoteContents = `DROP TABLE IF EXISTS note_contents;`
const deleteDetails = `DROP TABLE IF EXISTS details;`
const deleteSidebarImages = `DROP TABLE IF EXISTS sidebar_images;`
// const deleteWikiSettings = `DROP TABLE IF EXISTS wiki_settings;`
// const deleteUsers = `DROP TABLE IF EXISTS users;`

const insertNotes = `
INSERT INTO notes (
	path,
	title,
	alt_title,
	slug,
	frontpage,
	lead,
	allowed_users,
	hash,
	last_updated
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`

const insertNoteContents = `
INSERT INTO note_contents (
	note_path,
	chunk_id,
	"text",
	allowed_users,
	image_path,
	note_transclusion_path
) VALUES (?, ?, ?, ?, ?, ?);`

const insertDetails = `
INSERT INTO details (
	note_path,
	"order",
	detail_name,
	detail_content
) VALUES (?, ?, ?, ?);`

const insertSidebarImages = `
INSERT INTO sidebar_images (
	note_path,
	"order",
	image_name,
	image_path,
	caption
) VALUES (?, ?, ?, ?, ?);`

const insertWikiSettings = `
INSERT INTO wiki_settings (
	title,
	allow_logins
) VALUES (?, ?);`

const insertImage = `
INSERT INTO images (
	path,
	blob,
	alt,
	hash,
	last_updated,
	compressed
) VALUES (?, ?, ?, ?, ?, ?) RETURNING path;`

const insertUser = `
INSERT OR REPLACE INTO users (
	id,
	username,
	password
) VALUES (?, ?, ?);`

const selectImageData = `SELECT path, hash FROM images`

/**
 * Get the schema for a table using `PRAGMA table_info`
 */
async function getTableSchema(
	db: Database | Client,
	tableName: string,
	remote: boolean
): Promise<any[]> {
	if (remote) {
		const client = db as Client
		const res = await client.execute(`PRAGMA table_info(${tableName})`)
		return res.rows
	} else {
		const localDb = db as Database
		const res = localDb.exec(`PRAGMA table_info(${tableName})`)
		return (
			res[0]?.values.map((row) => ({
				cid: row[0],
				name: row[1],
				type: row[2],
				notnull: row[3],
				dflt_value: row[4],
				pk: row[5],
			})) || []
		)
	}
}

function schemaChanged(current: any[], desired: string): boolean {
	// Parse desired schema to extract column definitions
	const desiredCols = desired
		.split("\n")
		.filter(
			(line) =>
				!line.trim().startsWith(")") &&
				!line.trim().endsWith("(") &&
				!line.trim().endsWith(";") &&
				!line.trim().startsWith("PRIMARY") &&
				line.trim().length > 0
		)
		.map((line) => {
			const parts = line.trim().replace(/,$/, "").split(/\s+/)
			return {
				name: parts[0].replace(/"/g, ""),
				type: parts[1].toUpperCase(),
				constraints: parts.slice(2).join(" ").toUpperCase(),
			}
		})

	// If the number of columns is different, that's obviously a different schema
	if (current.length !== desiredCols.length) return true

	// Check each individual column name and type
	for (let i = 0; i < current.length; i++) {
		const currCol = current[i]
		const desCol = desiredCols[i]

		if (currCol.name !== desCol.name) return true
		if (currCol.type !== desCol.type) return true
		// Skip constraints check for simplicity
	}

	return false
}

export class LocalDatabaseAdapter implements DatabaseAdapter {
	remote: boolean
	constructor(private db: Database) {
		this.remote = false
	}

	async runMigrations(): Promise<void> {
		for (const table of tables) {
			try {
				const currentSchema = await getTableSchema(
					this.db,
					table.name,
					this.remote
				)
				if (
					currentSchema.length > 0 &&
					schemaChanged(currentSchema, table.schema)
				) {
					console.log(
						`Schema changed on ${table.name}. Recreating table...`
					)
					this.db.run(`DROP TABLE ${table.name}`)
				}
			} catch (e) {
				console.log("ERROR", e)
				// Table likely doesn't exist
			}
			this.db.run(table.schema)
		}

		for (const indexQuery of indexes) {
			this.db.run(indexQuery)
		}
	}

	async insertUsers(users: User[]) {
		for (const user of users) {
			this.db.run(insertUser, [user.id, user.username, user.password])
		}
	}

	async insertImages(
		images: {
			path: string
			alt: string
			hash: string
			buf: ArrayBuffer
		}[]
	): Promise<void> {
		for (const { path, alt, hash, buf } of images) {
			const U8Arr = new Uint8Array(buf)
			this.db.exec(insertImage, [
				path,
				U8Arr,
				alt,
				hash,
				Math.floor(Date.now() / 1000),
				1,
			])
		}
	}

	async deleteImagesByHashes(hashes: string[]): Promise<void> {
		if (hashes.length === 0) return
		const placeholders = hashes.map(() => "?").join(",")
		this.db.run(
			`DELETE FROM images WHERE hash IN (${placeholders})`,
			hashes
		)
	}

	async getImageData(): Promise<ImageData[]> {
		const res = this.db.exec(selectImageData)
		if (!res[0]) return []
		return res[0].values.map((val) => {
			return {
				path: val[0] as string,
				hash: val[1] as string,
			}
		})
	}

	async getNotes(): Promise<Note[]> {
		const res = this.db.exec("SELECT * FROM notes")
		if (!res[0]) return []
		return (
			res[0].values.map((val) => {
				return {
					path: val[0] as string,
					title: val[1] as string,
					alt_title: val[2] as string | null,
					slug: val[3] as string,
					frontpage: val[4] as string | number,
					lead: val[5] as string,
					allowed_users: val[6] as string | null,
					hash: val[7] as string,
					last_updated: val[8] as number,
				}
			}) ?? []
		)
	}

	async deleteNotesByHashes(hashes: string[]): Promise<void> {
		if (hashes.length === 0) return
		const placeholders = hashes.map(() => "?").join(",")
		this.db.run(`DELETE FROM notes WHERE hash IN (${placeholders})`, hashes)
	}

	async pushPages(
		pages: Pages,
		settings: WikiGeneratorSettings
	): Promise<void> {
		const noteQueries = []
		const noteContentsQueries = []
		const detailsQueries = []
		const sidebarImagesQueries = []

		for (const [notePath, page] of pages.entries()) {
			noteQueries.push({
				sql: insertNotes,
				args: [
					notePath,
					page.note.title,
					page.note.alt_title,
					page.note.slug,
					page.note.frontpage,
					page.note.lead,
					page.note.allowed_users,
					page.note.hash,
					page.note.last_updated,
				],
			})

			for (const chunk of page.chunks) {
				noteContentsQueries.push({
					sql: insertNoteContents,
					args: [
						notePath,
						chunk.chunk_id,
						chunk.text,
						chunk.allowed_users,
						chunk.image_path,
						chunk.note_transclusion_path,
					],
				})
			}

			for (const detail of page.details) {
				detailsQueries.push({
					sql: insertDetails,
					args: [notePath, detail.order, detail.key, detail.value],
				})
			}

			for (const img of page.sidebarImages) {
				sidebarImagesQueries.push({
					sql: insertSidebarImages,
					args: [
						notePath,
						img.order,
						img.image_name,
						img.image_path,
						img.caption,
					],
				})
			}
		}

		// Execute all inserts in a transaction
		this.db.run("BEGIN TRANSACTION;")
		for (const query of noteQueries) {
			this.db.run(query.sql, query.args)
		}
		for (const query of noteContentsQueries) {
			this.db.run(query.sql, query.args)
		}
		for (const query of detailsQueries) {
			this.db.run(query.sql, query.args)
		}
		for (const query of sidebarImagesQueries) {
			this.db.run(query.sql, query.args)
		}
		this.db.run(insertWikiSettings, [
			settings.wikiTitle,
			settings.allowLogins ? 1 : 0,
		])
		this.db.run("COMMIT;")
	}

	async clearContent(): Promise<void> {
		this.db.run(deleteNoteContents)
		this.db.run(deleteDetails)
		this.db.run(deleteSidebarImages)
		this.db.run(deleteImages)
		this.db.run(deleteNotes)
	}

	async export(vault: Vault, filename = "data.db"): Promise<void> {
		const buf = this.db.export()
		// Create a new ArrayBuffer and copy the data
		const newBuffer = new ArrayBuffer(buf.length)
		new Uint8Array(newBuffer).set(buf)
		await vault.adapter.writeBinary(
			findFileInPlugin(vault, filename, false),
			newBuffer
		)
	}

	async close(): Promise<void> {
		this.db.close()
	}
}

export class RemoteDatabaseAdapter implements DatabaseAdapter {
	remote: boolean
	constructor(private db: Client) {
		this.remote = true
	}

	async runMigrations(): Promise<void> {
		for (const table of tables) {
			try {
				const currentSchema = await getTableSchema(
					this.db,
					table.name,
					this.remote
				)
				if (
					currentSchema.length > 0 &&
					schemaChanged(currentSchema, table.schema)
				) {
					console.log(
						`Schema changed on ${table.name}. Recreating table...`
					)
					await this.db.execute(`DROP TABLE ${table.name}`)
				}
			} catch (e) {
				// Table likely doesn't exist
			}
			await this.db.execute(table.schema)
		}

		for (const indexQuery of indexes) {
			this.db.execute(indexQuery)
		}
	}

	async insertImages(
		images: {
			path: string
			alt: string
			hash: string
			buf: ArrayBuffer
		}[]
	): Promise<void> {
		for (const { path, alt, hash, buf } of images) {
			await this.db.execute({
				sql: insertImage,
				args: [path, buf, alt, hash, Math.floor(Date.now() / 1000), 1],
			})
		}
	}

	async deleteImagesByHashes(hashes: string[]): Promise<void> {
		if (hashes.length === 0) return
		const placeholders = hashes.map(() => "?").join(",")
		await this.db.execute({
			sql: `DELETE FROM images WHERE hash IN (${placeholders})`,
			args: hashes,
		})
	}

	async insertUsers(users: User[]) {
		for (const user of users) {
			await this.db.execute({
				sql: insertUser,
				args: [user.id, user.username, user.password],
			})
		}
	}

	async getImageData(): Promise<ImageData[]> {
		const res = await this.db.execute(selectImageData)
		//@ts-expect-error TypeScript doesn't know the schema
		return res.rows as ImageData[]
	}

	async getNotes(): Promise<Note[]> {
		const res = await this.db.execute("SELECT * FROM notes")
		//@ts-expect-error TypeScript doesn't know the schema
		return res.rows
	}

	async deleteNotesByHashes(hashes: string[]): Promise<void> {
		if (hashes.length === 0) return
		const placeholders = hashes.map(() => "?").join(",")
		await this.db.execute({
			sql: `DELETE FROM notes WHERE hash IN (${placeholders})`,
			args: hashes,
		})
	}

	async pushPages(
		pages: Pages,
		settings: WikiGeneratorSettings
	): Promise<void> {
		const noteQueries = []
		const noteContentsQueries = []
		const detailsQueries = []
		const sidebarImagesQueries = []

		for (const [notePath, page] of pages.entries()) {
			noteQueries.push({
				sql: insertNotes,
				args: [
					notePath,
					page.note.title,
					page.note.alt_title,
					page.note.slug,
					page.note.frontpage,
					page.note.lead,
					page.note.allowed_users,
					page.note.hash,
					page.note.last_updated,
				],
			})

			for (const chunk of page.chunks) {
				noteContentsQueries.push({
					sql: insertNoteContents,
					args: [
						notePath,
						chunk.chunk_id,
						chunk.text,
						chunk.allowed_users,
						chunk.image_path,
						chunk.note_transclusion_path,
					],
				})
			}

			for (const detail of page.details) {
				detailsQueries.push({
					sql: insertDetails,
					args: [notePath, detail.order, detail.key, detail.value],
				})
			}

			for (const img of page.sidebarImages) {
				sidebarImagesQueries.push({
					sql: insertSidebarImages,
					args: [
						notePath,
						img.order,
						img.image_name,
						img.image_path,
						img.caption,
					],
				})
			}
		}

		const queries = [
			...noteQueries,
			...noteContentsQueries,
			...detailsQueries,
			...sidebarImagesQueries,
			{
				sql: insertWikiSettings,
				args: [settings.wikiTitle, settings.allowLogins ? 1 : 0],
			},
		]
		await this.db.batch(queries)
	}

	async clearContent(): Promise<void> {
		await this.db.execute(deleteNoteContents)
		await this.db.execute(deleteDetails)
		await this.db.execute(deleteSidebarImages)
		await this.db.execute(deleteImages)
		await this.db.execute(deleteNotes)
	}

	async export(_vault: Vault): Promise<void> {
		console.warn(
			"Tried to export remote database. Only the local database can be exported. This should not happen."
		)
	}

	async close(): Promise<void> {
		this.db.close()
	}
}

export async function getUsersFromRemote(
	dbUrl: string,
	authToken: string
): Promise<User[]> {
	const client = createClient({
		url: dbUrl,
		authToken,
	})

	const res = await client.execute(`SELECT * FROM users;`)
	client.close()

	//@ts-expect-error
	return res.rows as User[]
}
