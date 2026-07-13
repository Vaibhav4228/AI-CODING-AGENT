import express, { Express, Response, Request } from 'express'
import cors from 'cors'
import path from 'node:path'
import { handleExpressError } from '../exceptions/handleExpressError'

export function expressServer(app: Express, PORT: number) {
    app.use(cors({
        origin: '*',
        credentials: true,
    }));

    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))
    app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));

    app.get('/', async (req: Request, res: Response) => {
        res.json({ message: "server is up" })
    })

    app.get('/test-app', (req, res) => {
        console.log("Test-app route hit!");
        res.json({ result: "hello" });
    });

    app.use(handleExpressError)

    app.listen(PORT, () => {
        console.log(`Express server is running at http://localhost:${PORT}`)
    })
}
