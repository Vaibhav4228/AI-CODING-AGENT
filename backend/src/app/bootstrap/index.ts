import { Express } from 'express'
import { expressServer } from './express/expressServer'

export function bootStrapApp(app: Express, PORT: number) {
    expressServer(app, PORT)
}
