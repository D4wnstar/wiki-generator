import { Notice } from "obsidian"
import postgres, { Sql } from "postgres"

/**
 * Initializes the database found at the given URL with all the features required
 * by the plugin.
 * @param dbUrl The URL used for the direct Postgres database connection
 */
export async function initializeDatabase(dbUrl: string) {
	const sql = createSqlClient(dbUrl)
	await setupInitialSchema(sql)
	sql.end()
}

/**
 * Convenience wrapper function to reset the database to its initial state.
 * Shouldn't be necessary, but it's useful to have an emergency global reset.
 * @param dbUrl The URL used for the direct Postgres database connection
 */
export async function resetDatabase(dbUrl: string) {
	const sql = createSqlClient(dbUrl)
	await nukeDatabase(sql)
	await setupInitialSchema(sql)
	sql.end()
}

export function createSqlClient(dbUrl: string) {
	const match = dbUrl.match(/postgresql:\/\/(.+?):(.+?)@(.+?):(\d+)\/(.+)/)
	if (!match) {
		new Notice("Invalid database URL")
		throw new Error("Invalid database URL")
	}
	const sql = postgres({
		username: match[1],
		password: match[2],
		host: match[3],
		port: parseInt(match[4]),
		database: match[5],
	})

	return sql
}

/**
 * Runs all SQL queries required to create the initial schema for the database and
 * takes care of adding extensions. Does not set up Supabase Storage, as that's
 * doable through the API. In substance, this function runs all database migrations
 * back to back.
 * @param sql A Postgres database connection
 */
async function setupInitialSchema(sql: Sql) {
	const jsonschema = await sql`
        create extension if not exists pg_jsonschema
        with schema extensions;
    `
	console.log(jsonschema)

	const notes = await sql`
        create table if not exists notes (
            id serial primary key,
            title text not null,
            alt_title text,
            path text unique not null,
            slug text unique not null,
            content text,
            frontpage boolean default false,
            "references" text array
        );`
    console.log(notes)

	const backreferences = await sql`
        create table if not exists backreferences (
            note_id integer not null references notes (id),
            slug text not null,
            display_name text not null,
            primary key (note_id, slug)
        );
    `
	console.log(backreferences)

	const details = await sql`
        create table if not exists details (
            note_id integer not null references notes (id),
            detail_name text not null,
            detail_content text not null,
            primary key (note_id, detail_name)
        );
    `
	console.log(details)

	const sidebar_images = await sql`
        create table if not exists sidebar_images (
            note_id integer not null references notes (id),
            image_name text not null,
            url text,
            caption text,
            primary key (note_id, image_name)
        );
    `
	console.log(sidebar_images)

	// const stored_media = await sql`
    //     create table if not exists stored_media (
    //         id serial primary key,
    //         media_name text unique not null,
    //         url text not null,
    //         media_type text not null
    //     );
    // `
	// console.log(stored_media)

    // TODO: Remember to update this every time the settings change
	const wiki_settings = await sql`
        create table if not exists wiki_settings (
            id serial primary key,
            settings jsonb not null,

            check (
                jsonb_matches_schema(
                    '{
                        "title": "string"
                    }',
                    settings
                )
            )
        );
    `
	console.log(wiki_settings)
}

/**
 * Instantly drops all plugin-related tables from the database in reverse
 * creation order. Shockingly enough, this is irreversible.
 * @param sql A Postgres database connection
 */
async function nukeDatabase(sql: Sql) {
	const dropSettings = await sql`
        drop table if exists wiki_settings
   `
	console.log(dropSettings)

// 	const dropStoredMedia = await sql`
//         drop table if exists stored_media
//    `
// 	console.log(dropStoredMedia)

	const dropSidebarImages = await sql`
        drop table if exists sidebar_images
   `
	console.log(dropSidebarImages)

	const dropDetails = await sql`
        drop table if exists details
   `
	console.log(dropDetails)

	const dropBackreferences = await sql`
        drop table if exists backreferences
   `
	console.log(dropBackreferences)

	const dropNotes = await sql`
        drop table if exists notes
   `
	console.log(dropNotes)
}
