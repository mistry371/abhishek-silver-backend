CREATE TABLE "parent_product_collections" (
	"parent_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	CONSTRAINT "parent_product_collections_parent_id_collection_id_pk" PRIMARY KEY("parent_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "parent_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_description" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category_id" uuid NOT NULL,
	"subcategory_id" uuid,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"default_variant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant_label" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_product_collections" ADD CONSTRAINT "parent_product_collections_parent_id_parent_products_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_product_collections" ADD CONSTRAINT "parent_product_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_products" ADD CONSTRAINT "parent_products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_products" ADD CONSTRAINT "parent_products_subcategory_id_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_products" ADD CONSTRAINT "parent_products_default_variant_id_products_id_fk" FOREIGN KEY ("default_variant_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_products_status_idx" ON "parent_products" USING btree ("status");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_parent_id_parent_products_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_parent_idx" ON "products" USING btree ("parent_id");