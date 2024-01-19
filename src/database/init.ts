import { Notice } from "obsidian"
import postgres, { Sql } from "postgres"

/**
 * A convenience wrapper to transform a raw connection URL into a Postgres Sql
 * object. Theoretically the `postgres()` constructor does that on its own, but
 * it never appears to actually parse the URL.
 * @param dbUrl A valid URL pointing at a Postgres database
 * @returns A Postgres Sql object
 */
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
 * Initializes the database found at the given URL with all the features required
 * by the plugin.
 * @param dbUrl The URL used for the direct Postgres database connection
 */
export async function initializeDatabase(dbUrl: string) {
	const sql = createSqlClient(dbUrl)
	await setupInitialSchema(sql)
    await applySecurityPolicies(sql)
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
    await applySecurityPolicies(sql)
	sql.end()
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
            "references" text array,
            allowed_users text array
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

	const profiles = await sql`
        create table if not exists profiles (
            id uuid primary key,
            email text not null unique,
            username text not null unique,
            groups text array
        );
    `
	console.log(profiles)

    const profileInsertSyncTriggerFunc = await sql`
        create or replace function sync_insert_profiles()
        returns trigger
        language plpgsql
        security definer set search_path = public
        as $$
        begin
            insert into profiles (id, email, username)
            values (new.id, new.email, new.raw_user_meta_data->>'username');
            return new;
        end;
        $$;
    `
    console.log(profileInsertSyncTriggerFunc)

    const profileInsertSyncTrigger = await sql`
        create or replace trigger sync_insert_profiles_trigger
        after insert on auth.users
        for each row
        execute function sync_insert_profiles();
    `
    console.log(profileInsertSyncTrigger)
    
    const profileUpdateSyncTriggerFunc = await sql`
        create or replace function sync_update_profiles()
        returns trigger
        language plpgsql
        security definer set search_path = public
        as $$
        begin
            update profiles
            set email = new.email, username = new.raw_user_meta_data->>'username'
            where id = new.id;
            return new;
        end;
        $$;
    `
    console.log(profileUpdateSyncTriggerFunc)

    const profileUpdateSyncTrigger = await sql`
        create or replace trigger sync_update_profiles_trigger
        after update on auth.users
        for each row
        execute function sync_update_profiles();
    `
    console.log(profileUpdateSyncTrigger)
    
    const profileDeleteSyncTriggerFunc = await sql`
        create or replace function sync_delete_profiles()
        returns trigger
        language plpgsql
        security definer set search_path = public
        as $$
        begin
            delete from profiles
            where id = new.id;
            return new;
        end;
        $$;
    `
    console.log(profileDeleteSyncTriggerFunc)

    const profileDeleteSyncTrigger = await sql`
        create or replace trigger sync_delete_profiles_trigger
        after delete on auth.users
        for each row
        execute function sync_delete_profiles();
    `
    console.log(profileDeleteSyncTrigger)
}

/**
 * Applies all Row Level Security policies on public tables.
 * Must be run after `setupInitialSchema()`.
 * @param sql A Postgres database connection
 */
async function applySecurityPolicies(sql: Sql) {
    const notesRls = await sql`
        alter table "notes" enable row level security;
    `
    console.log(notesRls)

    const notesPolicy = await sql`
        create policy "Notes are visible to either everyone or allowed users"
        on notes for select
        to authenticated, anon
        using ( 
            not exists (select 1 from unnest(allowed_users)) -- allows on an empty array
            or allowed_users @> array[(select username from profiles where auth.uid() = id)]
        );
    `
    console.log(notesPolicy)

    const backreferencesRls = await sql`
        alter table backreferences enable row level security;
    `
    console.log(backreferencesRls)

    const backreferencesPolicy = await sql`
        create policy "Backreferences are unrestricted"
        on backreferences for select
        to authenticated, anon
        using ( true );
    `
    console.log(backreferencesPolicy)

    const detailsRls = await sql`
        alter table details enable row level security;
    `
    console.log(detailsRls)

    const detailsPolicy = await sql`
        create policy "Details are unrestricted"
        on details for select
        to authenticated, anon
        using ( true );
    `
    console.log(detailsPolicy)

    const imagesRls = await sql`
        alter table sidebar_images enable row level security;
    `
    console.log(imagesRls)

    const imagesPolicy = await sql`
        create policy "Sidebar images are unrestricted"
        on sidebar_images for select
        to authenticated, anon
        using ( true );
    `
    console.log(imagesPolicy)

    const settingsRls = await sql`
        alter table wiki_settings enable row level security;
    `
    console.log(settingsRls)

    const settingsPolicy = await sql`
        create policy "Wiki settings are unrestricted"
        on wiki_settings for select
        to authenticated, anon
        using ( true );
    `
    console.log(settingsPolicy)

    const profilesRls = await sql`
        alter table profiles enable row level security;
    `
    console.log(profilesRls)

    const profilesPolicy = await sql`
        create policy "Profiles are visible only to the owner of the profiles"
        on profiles for select
        to authenticated
        using ( auth.uid() = id );
    `
    console.log(profilesPolicy)
}

/**
 * Instantly drops all notes-related tables, triggers and function from the
 * database in reverse creation order. Shockingly enough, this is irreversible.
 * @param sql A Postgres database connection
 */
async function nukeDatabase(sql: Sql) {
    const dropInsertSyncTrigger = await sql`
        drop trigger if exists sync_insert_profiles_trigger on auth.users
    `
    console.log(dropInsertSyncTrigger)
    
    const dropUpdateSyncTrigger = await sql`
        drop trigger if exists sync_update_profiles_trigger on auth.users
    `
    console.log(dropUpdateSyncTrigger)
    
    const dropDeleteSyncTrigger = await sql`
        drop trigger if exists sync_delete_profiles_trigger on auth.users
    `
    console.log(dropDeleteSyncTrigger)

    const dropInsertSyncFunction = await sql`
        drop function if exists sync_insert_profiles
    `
    console.log(dropInsertSyncFunction)

    const dropUpdateSyncFunction = await sql`
        drop function if exists sync_update_profiles
    `
    console.log(dropUpdateSyncFunction)

    const dropDeleteSyncFunction = await sql`
        drop function if exists sync_delete_profiles
    `
    console.log(dropDeleteSyncFunction)

	const dropSettings = await sql`
        drop table if exists wiki_settings
   `
	console.log(dropSettings)

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