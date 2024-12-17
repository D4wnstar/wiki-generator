import { requestUrl } from "obsidian"
import { User } from "src/database/types"
import { WikiGeneratorSettings } from "src/settings"

export async function getUsers(
	settings: WikiGeneratorSettings
): Promise<User[]> {
	const siteUrl = settings.websiteUrl
	const res = await requestUrl({
		url: `${siteUrl}/api/v1/auth/get-all-users`,
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.adminApiKey}`,
			"Content-Type": "application/json",
		},
	})
	const { users } = res.json
	return users
}
