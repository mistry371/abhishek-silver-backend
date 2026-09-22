import { Router } from "express";
import { requireAdmin } from "@/http/auth";
import { adminAuthRouter } from "./auth-routes";
import { billingRouter } from "./billing";
import { catalogueRouter } from "./catalogue";
import { contentAdminRouter } from "./content";
import { customersRouter } from "./customers";
import { dashboardRouter } from "./dashboard";
import { enquiriesAdminRouter } from "./enquiries";
import { expensesRouter } from "./expenses";
import { importsRouter } from "./imports";
import { inventoryRouter } from "./inventory";
import { marketingRouter } from "./marketing";
import { notificationsRouter } from "./notifications";
import { ordersAdminRouter } from "./orders";
import { parentProductsRouter } from "./parent-products";
import { pricingRouter } from "./pricing";
import { purchasingRouter } from "./purchasing";
import { reportsRouter } from "./reports";
import { salesRouter } from "./sales";
import { searchRouter } from "./search";
import { settingsRouter } from "./settings";

export const adminRouter = Router();

adminRouter.use(adminAuthRouter);

/** Everything below requires a signed-in, active admin; each route checks its own permissions. */
const secured = Router();
secured.use(requireAdmin);
secured.use(
  dashboardRouter,
  searchRouter,
  notificationsRouter,
  customersRouter,
  catalogueRouter,
  parentProductsRouter,
  inventoryRouter,
  purchasingRouter,
  ordersAdminRouter,
  billingRouter,
  salesRouter,
  expensesRouter,
  pricingRouter,
  marketingRouter,
  contentAdminRouter,
  enquiriesAdminRouter,
  reportsRouter,
  settingsRouter,
  importsRouter,
);

adminRouter.use(secured);
