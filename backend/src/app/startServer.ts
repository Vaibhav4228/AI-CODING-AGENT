import { Express } from 'express'
import { expressServer } from './http/expressServer'
import { dbConnection } from './database/connect'
import { ensureCheckpointerReady } from './database/checkpointer'

export async function startServer(app: Express, PORT: number) {
    await dbConnection()
    await ensureCheckpointerReady()
    expressServer(app, PORT)
}
