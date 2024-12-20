import { createClient, Row } from "@libsql/client"
import { WikiGeneratorSettings } from "src/settings"

const selectAllUsers = `SELECT * FROM users;`

export async function getUsers(
	settings: WikiGeneratorSettings
): Promise<Row[]> {
	const client = createClient({
		url: settings.dbUrl,
		authToken: settings.dbToken,
	})

	const res = await client.execute(selectAllUsers)

	client.close()
	return res.rows
}
