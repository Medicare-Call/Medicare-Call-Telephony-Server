import express from 'express';
import cors from 'cors';
import callRoutes from './routes/call.routes';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/call', callRoutes);

export default app;
