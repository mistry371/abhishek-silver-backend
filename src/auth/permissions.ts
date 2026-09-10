/**
 * PERMISSION CATALOGUE
 * ------------------------------------------------------------------
 * Default role grants follow the Role & Permission Matrix in the platform
 * documentation (§19). The document notes exact permissions must be
 * finalised before production — Super Admins can adjust roles in
 * Settings → Roles without a code change. The Super Admin role always
 * holds every permission so the business can never lock itself out.
 */

export const permissionGroups = [
  {
    module: "Dashboard",
    permissions: {
      "dashboard:view": "View the dashboard",
      "dashboard:financials": "See sales, revenue, billed value and expense KPIs",
    },
  },
  {
    module: "Customers",
    permissions: {
      "customers:view": "View customers and Customer 360",
      "customers:manage": "Edit customer profiles, status and addresses",
      "customers:notes": "Add internal customer notes",
    },
  },
  {
    module: "Products",
    permissions: {
      "products:view": "View products",
      "products:create": "Create products",
      "products:delete": "Delete products",
      "products:edit_content": "Edit names, descriptions, media, SEO, taxonomy and status",
      "products:edit_merchandising": "Edit merchandising flags and product discounts",
      "products:edit_inventory": "Edit SKU, barcode, metal, purity, weights and sizes",
      "products:edit_pricing": "Edit making, stone and other charges",
      "products:view_confidential": "View and edit purchase price and supplier",
      "catalog:manage_taxonomy": "Manage categories, subcategories and collections",
    },
  },
  {
    module: "Inventory",
    permissions: {
      "inventory:view": "View stock levels and movement history",
      "inventory:adjust": "Add, reduce, adjust and transfer stock",
      "inventory:view_valuation": "View inventory valuation",
    },
  },
  {
    module: "Purchases",
    permissions: {
      "vendors:view": "View vendors",
      "vendors:manage": "Create and edit vendors",
      "purchases:view": "View purchases",
      "purchases:create": "Create and submit purchases",
      "purchases:approve": "Approve or cancel purchases (updates inventory)",
    },
  },
  {
    module: "Billing",
    permissions: {
      "billing:view": "View invoices",
      "billing:create": "Create and edit draft invoices",
      "billing:issue": "Issue (finalise) invoices",
      "billing:record_payment": "Record invoice payments",
      "billing:cancel": "Cancel invoices",
    },
  },
  {
    module: "Sales",
    permissions: {
      "sales:view": "View sales",
      "sales:create": "Record manual sales",
    },
  },
  {
    module: "Orders",
    permissions: {
      "orders:view": "View orders",
      "orders:update_status": "Change order status",
      "orders:manage": "Edit shipping details, notes and communications",
      "orders:returns": "Create and process returns",
      "orders:refunds": "Create and process refunds",
    },
  },
  {
    module: "Expenses",
    permissions: {
      "expenses:view": "View expenses",
      "expenses:create": "Create, edit and submit expenses",
      "expenses:approve": "Approve, reject and mark expenses paid",
      "expenses:manage_categories": "Manage expense categories and recurring expenses",
    },
  },
  {
    module: "Pricing",
    permissions: {
      "pricing:view": "View metal rates, charge rules and price history",
      "pricing:manage": "Change metal rates, GST and charge rules",
    },
  },
  {
    module: "Marketing",
    permissions: {
      "marketing:view": "View coupons and offers",
      "marketing:manage": "Create and edit coupons and offers",
    },
  },
  {
    module: "Content",
    permissions: {
      "content:view": "View website content",
      "content:manage": "Edit homepage, about, testimonials, FAQs, blog, contact and social links",
    },
  },
  {
    module: "Enquiries",
    permissions: {
      "enquiries:view": "View enquiries",
      "enquiries:manage": "Update status, assign, add notes and contact history",
    },
  },
  {
    module: "Reports",
    permissions: {
      "reports:sales": "Sales, revenue and best-seller reports",
      "reports:orders": "Order reports",
      "reports:customers": "Customer and purchase history reports",
      "reports:products": "Product reports",
      "reports:inventory": "Inventory, stock and low-stock reports",
      "reports:purchases": "Purchase reports",
      "reports:billing": "Billing and invoice reports",
      "reports:expenses": "Expense reports",
    },
  },
  {
    module: "Settings",
    permissions: {
      "settings:view": "View business settings",
      "settings:manage": "Change business settings",
      "settings:manage_users": "Manage admin users, roles and permissions",
      "audit:view": "View the audit log",
    },
  },
] as const;

type Group = (typeof permissionGroups)[number];
export type Permission = { [G in Group as string]: keyof G["permissions"] }[string] & string;

export const ALL_PERMISSIONS = permissionGroups.flatMap((group) => Object.keys(group.permissions)) as Permission[];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

export const SUPER_ADMIN_ROLE = "super_admin";

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export const defaultRoles: RoleDefinition[] = [
  {
    id: SUPER_ADMIN_ROLE,
    name: "Super Admin",
    description: "Full access to every module, settings, users and roles.",
    permissions: ALL_PERMISSIONS,
  },
  {
    id: "inventory_manager",
    name: "Inventory Manager",
    description: "Inventory, product inventory fields, inventory-related purchases and inventory reports.",
    permissions: [
      "dashboard:view",
      "customers:view",
      "products:view",
      "products:create",
      "products:edit_inventory",
      "products:view_confidential",
      "inventory:view",
      "inventory:adjust",
      "inventory:view_valuation",
      "vendors:view",
      "purchases:view",
      "purchases:create",
      "orders:view",
      "pricing:view",
      "reports:inventory",
      "reports:purchases",
    ],
  },
  {
    id: "sales_manager",
    name: "Sales Manager",
    description: "Customers, orders, sales, billing, enquiries and sales/order reports.",
    permissions: [
      "dashboard:view",
      "dashboard:financials",
      "customers:view",
      "customers:manage",
      "customers:notes",
      "products:view",
      "products:edit_merchandising",
      "inventory:view",
      "billing:view",
      "billing:create",
      "billing:issue",
      "billing:record_payment",
      "billing:cancel",
      "sales:view",
      "sales:create",
      "orders:view",
      "orders:update_status",
      "orders:manage",
      "orders:returns",
      "orders:refunds",
      "pricing:view",
      "marketing:view",
      "marketing:manage",
      "enquiries:view",
      "enquiries:manage",
      "reports:sales",
      "reports:orders",
      "reports:customers",
      "reports:billing",
    ],
  },
  {
    id: "content_manager",
    name: "Content Manager",
    description: "Website content, product content fields, taxonomy and content/product reports.",
    permissions: [
      "dashboard:view",
      "products:view",
      "products:create",
      "products:edit_content",
      "products:edit_merchandising",
      "catalog:manage_taxonomy",
      "marketing:view",
      "content:view",
      "content:manage",
      "enquiries:view",
      "reports:products",
    ],
  },
];
