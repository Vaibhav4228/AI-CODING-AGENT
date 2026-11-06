import express from 'express'
import './config/environment'
import { startServer } from './app/startServer'

const app = express()
const PORT = Number(process.env.PORT ?? 5000)

startServer(app, PORT).catch((error) => {
    console.error('Failed to start app:', error)
    process.exit(1)
})
