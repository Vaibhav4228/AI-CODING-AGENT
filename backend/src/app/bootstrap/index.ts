import { Express } from 'express'
import { expressServer } from './express/expressServer'
import { dbConnection } from './mongoose/db'
import { ensureCheckpointerReady } from './checkpointer/mongodb-checkpointer'

export async function bootStrapApp(app: Express, PORT: number) {
    await dbConnection()
    await ensureCheckpointerReady()
    expressServer(app, PORT)
}
