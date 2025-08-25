import { Client, createClient } from "@libsql/client"
import { Database } from "sql.js"
import {
	Page,
	User,
	DatabaseAdapter,
	Note,
	ImageData,
} from "src/database/types"
import { WikiGeneratorSettings } from "src/settings"
import { Vault } from "obsidian"
import { findFileInPlugin } from "./filesystem"

// IMPORTANT: Update the type definitions if these are changed!
// Both in database/types.ts and in the frontend template.

const createNotes = `
CREATE TABLE IF NOT EXISTS notes (
	path TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	alt_title TEXT,
	search_terms TEXT NOT NULL, -- semicolon separated list. Default should be alt_title ?? title
	slug TEXT UNIQUE NOT NULL,
	frontpage BOOLEAN DEFAULT FALSE,
	lead TEXT NOT NULL,
	allowed_users TEXT,
	hash TEXT NOT NULL, -- hash is calculated BEFORE preprocessing anything!
	last_updated INTEGER NOT NULL,
	can_prerender BOOLEAN NOT NULL,
	html_content TEXT NOT NULL
);`

const createImages = `
CREATE TABLE IF NOT EXISTS images (
	path TEXT PRIMARY KEY,
	blob BLOB, -- for raster images
	svg_text TEXT, -- for SVG images
	alt TEXT,
	hash TEXT NOT NULL,
	last_updated INTEGER NOT NULL,
	compressed BOOLEAN NOT NULL
);`

const createDetails = `
CREATE TABLE IF NOT EXISTS details (
	note_path TEXT NOT NULL REFERENCES notes (path) ON DELETE CASCADE,
	"order" INTEGER NOT NULL,
	"key" TEXT,
	value TEXT,
	PRIMARY KEY (note_path, "order")
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

const tables = [
	{ name: "notes", schema: createNotes },
	{ name: "images", schema: createImages },
	{ name: "details", schema: createDetails },
	{ name: "sidebar_images", schema: createSidebarImages },
	{ name: "wiki_settings", schema: createWikiSettings },
	{ name: "users", schema: createUsers },
]

const indexes = [createNotesAllowedUsersIndex]

const deleteTableNotes = `DROP TABLE IF EXISTS notes;`
const deleteTableImages = `DROP TABLE IF EXISTS images;`
const deleteTableDetails = `DROP TABLE IF EXISTS details;`
const deleteTableSidebarImages = `DROP TABLE IF EXISTS sidebar_images;`
// const deleteTableWikiSettings = `DROP TABLE IF EXISTS wiki_settings;`
// const deleteTableUsers = `DROP TABLE IF EXISTS users;`

const insertNotes = `\
INSERT OR REPLACE INTO notes (
	path,
	title,
	alt_title,
	search_terms,
	slug,
	frontpage,
	lead,
	allowed_users,
	hash,
	last_updated,
	can_prerender,
	html_content
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING path;`

const insertDetails = `\
INSERT INTO details (
	note_path,
	"order",
	"key",
	value
) VALUES (?, ?, ?, ?);`

const insertSidebarImages = `\
INSERT INTO sidebar_images (
	note_path,
	"order",
	image_name,
	image_path,
	caption
) VALUES (?, ?, ?, ?, ?);`

const insertWikiSettings = `\
INSERT INTO wiki_settings (
	title,
	allow_logins
) VALUES (?, ?);`

const insertImage = `\
INSERT OR REPLACE INTO images (
	path,
	blob,
	svg_text,
	alt,
	hash,
	last_updated,
	compressed
) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING path;`

const insertUser = `\
INSERT OR REPLACE INTO users (
	id,
	username,
	password
) VALUES (?, ?, ?);`

const selectImageData = `SELECT path, hash FROM images;`

const deleteNotesByPath = `DELETE FROM notes WHERE path = ? RETURNING path`
const deleteImagesByPath = `DELETE FROM images WHERE path = ? RETURNING path`

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
			const trimmed = line.trim().replace(/,$/, "")
			const nameMatch = trimmed.match(/^"?([^"\s]+)"?/)
			if (!nameMatch) return null

			const name = nameMatch[1]
			const remaining = trimmed.slice(nameMatch[0].length).trim()
			const typeMatch = remaining.match(/^([^\s,]+)/)
			if (!typeMatch) return null

			return {
				name,
				type: typeMatch[1].toUpperCase(),
				// Ignore constraints for comparison
			}
		})
		.filter(Boolean) // Filter out any nulls from failed parsing

	// If the number of columns is different, that's obviously a different schema
	if (current.length !== desiredCols.length) {
		console.debug(
			`Schema column count mismatch: current=${current.length}, desired=${desiredCols.length}`
		)
		return true
	}

	// Check each individual column name and type
	for (let i = 0; i < current.length; i++) {
		const currCol = current[i]
		const desCol = desiredCols[i]

		if (!desCol) {
			console.debug(`Missing desired column at position ${i}`)
			return true
		}

		if (currCol.name !== desCol.name) {
			console.debug(
				`Column name mismatch at position ${i}: current='${currCol.name}', desired='${desCol.name}'`
			)
			return true
		}
		if (currCol.type.toUpperCase() !== desCol.type) {
			console.debug(
				`Column type mismatch at position ${i}: current='${currCol.type}', desired='${desCol.type}'`
			)
			return true
		}
	}

	return false
}

export class LocalDatabaseAdapter implements DatabaseAdapter {
	remote: boolean
	constructor(private db: Database) {
		this.remote = false
	}

	async runMigrations(): Promise<void> {
		try {
			this.db.run("BEGIN TRANSACTION;")
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
					console.error("ERROR", e)
					// Table likely doesn't exist
				}
				this.db.run(table.schema)
			}

			for (const indexQuery of indexes) {
				this.db.run(indexQuery)
			}
			this.db.run("COMMIT;")
		} catch (error) {
			this.db.run("ROLLBACK;")
			console.error("Migration failed:", error)
			throw new Error("Database migration failed.")
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
			buf: ArrayBuffer | null
			svg_text: string | null
		}[]
	): Promise<string[]> {
		const insertedPaths: string[] = []
		this.db.run("BEGIN TRANSACTION;")
		try {
			for (const { path, alt, hash, buf, svg_text } of images) {
				const U8Arr = buf ? new Uint8Array(buf) : null
				const res = this.db.exec(insertImage, [
					path,
					U8Arr,
					svg_text,
					alt,
					hash,
					Math.floor(Date.now() / 1000),
					1,
				])
				// res: [
				//  	{ columns: ['path'], values: [['a/b/c'], ['b/c/d'], ...] }
				// ]
				if (res[0]?.values) {
					insertedPaths.push(
						...res[0].values.map((row) => row[0] as string)
					)
				}
			}
			this.db.run("COMMIT;")
			return insertedPaths
		} catch (e) {
			console.error(`Error when inserting images: ${e}`)
			this.db.run("ROLLBACK;")
			return []
		}
	}

	async deleteImagesByPath(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0
		let totalDeleted = 0
		this.db.run("BEGIN TRANSACTION;")
		try {
			for (const path of paths) {
				const res = this.db.exec(deleteImagesByPath, [path])
				if (res[0]?.values) totalDeleted += res[0].values.length
			}
			this.db.run("COMMIT;")
			return totalDeleted
		} catch (e) {
			console.error(`Error when deleting images: ${e}`)
			this.db.run("ROLLBACK;")
			return 0
		}
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
					search_terms: val[3] as string,
					slug: val[4] as string,
					frontpage: val[5] as string | number,
					lead: val[6] as string,
					allowed_users: val[7] as string | null,
					hash: val[8] as string,
					last_updated: val[9] as number,
					can_prerender: val[10] as number,
					html_content: val[11] as string,
				}
			}) ?? []
		)
	}

	async deleteNotesByPath(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0
		let totalDeleted = 0
		this.db.run("BEGIN TRANSACTION;")
		try {
			for (const path of paths) {
				const res = this.db.exec(deleteNotesByPath, [path])
				if (res[0]?.values) totalDeleted += res[0].values.length
			}
			this.db.run("COMMIT;")
			return totalDeleted
		} catch (e) {
			console.error(`Error when deleting notes: ${e}`)
			this.db.run("ROLLBACK;")
			return 0
		}
	}

	async insertPages(pages: Page[]): Promise<number> {
		const noteQueries = []
		const detailsQueries = []
		const sidebarImagesQueries = []

		for (const page of pages) {
			noteQueries.push({
				sql: insertNotes,
				args: [
					page.note.path,
					page.note.title,
					page.note.alt_title,
					page.note.search_terms,
					page.note.slug,
					page.note.frontpage,
					page.note.lead,
					page.note.allowed_users,
					page.note.hash,
					page.note.last_updated,
					page.note.can_prerender,
					page.note.html_content,
				],
			})

			for (const detail of page.details) {
				detailsQueries.push({
					sql: insertDetails,
					args: [
						page.note.path,
						detail.order,
						detail.key,
						detail.value,
					],
				})
			}

			for (const img of page.sidebarImages) {
				sidebarImagesQueries.push({
					sql: insertSidebarImages,
					args: [
						page.note.path,
						img.order,
						img.image_name,
						img.image_path,
						img.caption,
					],
				})
			}
		}

		// Execute all inserts in a transaction
		let inserted = 0
		this.db.run("BEGIN TRANSACTION;")
		try {
			for (const query of noteQueries) {
				try {
					const res = this.db.exec(query.sql, query.args)
					// INSERT is RETURNING so the result has the same number of rows that were inserted
					if (res[0]?.values) inserted += res[0].values.length
				} catch (error) {
					console.error(`Error inserting note: ${error}`, query)
					throw error
				}
			}
			for (const query of detailsQueries) {
				try {
					this.db.exec(query.sql, query.args)
				} catch (error) {
					console.error(`Error inserting detail: ${error}`, query)
					throw error
				}
			}
			for (const query of sidebarImagesQueries) {
				try {
					this.db.exec(query.sql, query.args)
				} catch (error) {
					console.error(
						`Error inserting sidebar image metadata: ${error}`,
						query
					)
					throw error
				}
			}
			this.db.run("COMMIT;")
			return inserted
		} catch (e) {
			console.error(`Error when inserting pages: ${e}`)
			this.db.run("ROLLBACK;")
			return 0
		}
	}

	async updateSettings(settings: WikiGeneratorSettings): Promise<void> {
		this.db.run("BEGIN TRANSACTION;")
		this.db.run("DELETE FROM wiki_settings;")
		this.db.run(insertWikiSettings, [
			settings.wikiTitle,
			settings.allowLogins ? 1 : 0,
		])
		this.db.run("COMMIT;")
	}

	async clearContent(): Promise<void> {
		this.db.run("BEGIN TRANSACTION;")
		this.db.run(deleteTableDetails)
		this.db.run(deleteTableSidebarImages)
		this.db.run(deleteTableImages)
		this.db.run(deleteTableNotes)
		this.db.run("COMMIT;")
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
			svg_text: string | null
		}[]
	): Promise<string[]> {
		const insertedPaths: string[] = []
		for (const { path, alt, hash, buf, svg_text } of images) {
			await withRetry(async () => {
				const result = await this.db.execute({
					sql: insertImage,
					args: [
						path,
						buf,
						svg_text,
						alt,
						hash,
						Math.floor(Date.now() / 1000),
						1,
					],
				})
				insertedPaths.push(
					...result.rows.map((row) => row.path as string)
				)
			}, 3)
		}
		return insertedPaths
	}

	async deleteImagesByPath(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0
		const queries = paths.map((path) => ({
			sql: deleteImagesByPath,
			args: [path],
		}))
		const results = await this.db.batch(queries)
		return results.reduce((sum, res) => sum + (res.rows.length ?? 0), 0)
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

	async deleteNotesByPath(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0
		const queries = paths.map((path) => ({
			sql: deleteNotesByPath,
			args: [path],
		}))
		const results = await this.db.batch(queries)
		return results.reduce((sum, res) => sum + (res.rows.length ?? 0), 0)
	}

	async insertPages(pages: Page[]): Promise<number> {
		return await withRetry(async () => {
			const noteQueries = []
			const detailsQueries = []
			const sidebarImagesQueries = []

			for (const page of pages) {
				noteQueries.push({
					sql: insertNotes,
					args: [
						page.note.path,
						page.note.title,
						page.note.alt_title,
						page.note.search_terms,
						page.note.slug,
						page.note.frontpage,
						page.note.lead,
						page.note.allowed_users,
						page.note.hash,
						page.note.last_updated,
						page.note.can_prerender,
						page.note.html_content,
					],
				})

				for (const detail of page.details) {
					detailsQueries.push({
						sql: insertDetails,
						args: [
							page.note.path,
							detail.order,
							detail.key,
							detail.value,
						],
					})
				}

				for (const img of page.sidebarImages) {
					sidebarImagesQueries.push({
						sql: insertSidebarImages,
						args: [
							page.note.path,
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
				...detailsQueries,
				...sidebarImagesQueries,
			]
			const results = await this.db.batch(queries)
			return results.reduce((sum, res) => sum + (res.rows.length ?? 0), 0)
		}, 3)
	}

	async updateSettings(settings: WikiGeneratorSettings): Promise<void> {
		await this.db.batch([
			"DELETE FROM wiki_settings;",
			{
				sql: insertWikiSettings,
				args: [settings.wikiTitle, settings.allowLogins ? 1 : 0],
			},
		])
	}

	async clearContent(): Promise<void> {
		await withRetry(async () => {
			await this.db.batch([
				deleteTableDetails,
				deleteTableSidebarImages,
				deleteTableImages,
				deleteTableNotes,
			])
		}, 3)
	}

	async export(_vault: Vault): Promise<void> {
		throw new Error(
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

/**
 * Helper function to retry an async operation with exponential backoff
 * @param fn The async function to retry
 * @param maxRetries Maximum number of retry attempts
 * @returns Promise that resolves when fn succeeds or all retries are exhausted
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	maxRetries: number
): Promise<T> {
	let retries = maxRetries
	while (retries > 0) {
		try {
			return await fn()
		} catch (error) {
			retries -= 1
			if (retries === 0) {
				console.error(
					`Failed to complete operation within ${maxRetries} attempts. Error: ${error}`
				)
				throw error
			}
			// Exponential backoff before retry
			await new Promise((resolve) =>
				setTimeout(resolve, 1000 * (maxRetries - retries + 1))
			)
		}
	}
	throw new Error("Retry logic failed - should never reach here")
}
