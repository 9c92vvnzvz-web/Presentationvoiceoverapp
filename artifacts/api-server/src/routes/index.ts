import { Router, type IRouter } from "express";
import healthRouter from "./health";
import presentationsRouter from "./presentations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(presentationsRouter);

export default router;
