import express from 'express'
import 'dotenv/config'
import { bootStrapApp } from './app/bootstrap/index'

const app = express()
const PORT = parseInt(process.env.PORT as string)

bootStrapApp(app, PORT).catch((error) => {
    console.error('Failed to start app:', error)
    process.exit(1)
})
