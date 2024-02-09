import { SupabaseClient, createClient } from "@supabase/supabase-js"
import { supabase } from "main"
import { Notice } from "obsidian"
import { DatabaseError } from "src/notes/types"
import { WikiGeneratorSettings } from "src/settings"

export function createClientWrapper(settings: WikiGeneratorSettings) {
	let client: SupabaseClient

	if (
		settings.supabaseUseLocal &&
		settings.supabaseApiUrlLocal &&
		settings.supabaseServiceKeyLocal
	) {
		client = createClient(
			settings.supabaseApiUrlLocal,
			settings.supabaseServiceKeyLocal
		)
	} else if (settings.supabaseApiUrl && settings.supabaseServiceKey) {
		client = createClient(
			settings.supabaseApiUrl,
			settings.supabaseServiceKey
		)
	} else {
		throw new Error(
			"Please set both the URL and Service Key for Supabase in the settings"
		)
	}

	return client
}

export async function getFilesInStorage(supabase: SupabaseClient) {
	const { data: mediaInStorage, error: storageError } = await supabase.storage
		.from("images")
		.list()

	if (storageError) {
		throw new DatabaseError(
			`${storageError.message}\nIf you just created your Supabase database, try waiting a couple minutes and then try again.`
		)
	}

	return mediaInStorage
}

export async function getProfiles() {
	const { data, error } = await supabase.from("profiles").select("*")
	if (error) {
		new Notice(
			`There was an error fetching the users.\nError: ${error.message}`
		)
		console.error(`There was an error fetching the users.\nError: ${error.message}`)
		return []
	}

	return data.sort((a, b) => a.username.localeCompare(b.username))
}