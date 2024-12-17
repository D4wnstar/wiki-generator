import { Root } from "remark-parse/lib"
import { Database } from "sql.js"
import { Pages, User } from "src/database/types"
import { WikiGeneratorSettings } from "src/settings"
import { Processor } from "unified"

export function runMigrations(db: Database) {
	db.run(`
        CREATE TABLE IF NOT EXISTS notes (
            id integer primary key,
            title text not null,
            alt_title text,
            path text unique not null,
            slug text unique not null,
            frontpage boolean default false,
            lead text not null,
            allowed_users text
        );
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS note_contents (
            note_id integer not null references notes (id) on delete cascade,
            chunk_id integer not null,
            "text" text not null,
            allowed_users text,
            primary key (note_id, chunk_id)
        );
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS details (
            note_id integer not null references notes (id) on delete cascade,
            "order" integer not null,
            detail_name text not null,
            detail_content text,
            primary key (note_id, detail_name)
        );
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS sidebar_images (
            note_id integer not null references notes (id) on delete cascade,
            "order" integer not null,
            image_name text not null,
            base64 text not null,
            caption text,
            primary key (note_id, image_name)
        );
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS wiki_settings (
            id integer primary key,
            title text not null,
            allow_logins boolean not null
        );
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id integer primary key,
            username text not null unique,
            password text not null
        );
    `)
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

export async function convertWikilinksAndInsert(
	db: Database,
	pages: Pages,
	settings: WikiGeneratorSettings,
	postprocessor: Processor<Root, undefined, undefined, Root, string>
) {
	for (const [noteId, page] of pages.entries()) {
		db.run(
			`
			INSERT INTO notes (
				id,
				title,
				alt_title,
				path,
				slug,
				frontpage,
				lead,
				allowed_users
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
		`,
			[
				noteId,
				page.note.title,
				page.note.alt_title,
				page.note.path,
				page.note.slug,
				page.note.frontpage,
				page.note.lead,
				page.note.allowed_users,
			]
		)

		for (const chunk of page.chunks) {
			const vfile = await postprocessor.process(chunk.text)
			const text = String(vfile)
			const allowed_users =
				chunk.allowed_users.length > 0
					? chunk.allowed_users.join(";")
					: null
			db.run(
				`
				INSERT INTO note_contents (
					note_id,
					chunk_id,
					"text",
					allowed_users
				) VALUES (?, ?, ?, ?);
			`,
				[noteId, chunk.chunk_id, text, allowed_users]
			)
		}

		for (const detail of page.details) {
			const vfile = detail.value
				? await postprocessor.process(detail.value)
				: undefined
			const content = vfile ? String(vfile) : null
			db.run(
				`
				INSERT INTO details (
					note_id,
					"order",
					detail_name,
					detail_content
				) VALUES (?, ?, ?, ?);
			`,
				[noteId, detail.order, detail.key, content]
			)
		}

		for (const img of page.sidebarImages) {
			const vfile = img.caption
				? await postprocessor.process(img.caption)
				: undefined
			const caption = vfile ? String(vfile) : null
			db.run(
				`
				INSERT INTO sidebar_images (
					note_id,
					"order",
					image_name,
					base64,
					caption
				) VALUES (?, ?, ?, ?, ?);
			`,
				[noteId, img.order, img.image_name, img.base64, caption]
			)
		}
	}

	db.run(
		`
		INSERT INTO wiki_settings (
			title,
			allow_logins
		) VALUES (?, ?);
	`,
		[settings.wikiTitle, settings.allowLogins ? 1 : 0]
	)
}
