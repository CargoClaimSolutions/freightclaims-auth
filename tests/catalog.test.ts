import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyLocalCatalogProfile,
  catalogSchema,
  rolesForProduct,
  secretPrefix,
} from "../src/catalog.js";

const baseCatalog = {
  issuer: "https://auth.example.com",
  console_path: "/ui/console",
  instance_organization: {
    name: "Example",
    domain: "example.com",
  },
  email: {
    from_address: "noreply@example.com",
    default_from_name: "Example",
  },
  products: [
    {
      id: "freightcheck",
      display_name: "FreightCheck",
      auth_origin: "https://auth.freightcheck.io",
      email_from_name: "FreightCheck",
      owner_organization: {
        name: "FreightCheck",
        domain: "freightcheck.io",
      },
      branding: {
        primary_color: "#123456",
        warn_color: "#123456",
        background_color: "#123456",
        font_color: "#123456",
        primary_color_dark: "#123456",
        warn_color_dark: "#123456",
        background_color_dark: "#123456",
        font_color_dark: "#123456",
      },
      applications: [
        {
          environment: "production",
          name: "FreightCheck production web",
          base_url: "https://app.freightcheck.io",
          management_service_account: {
            id: "01900000-0000-7000-8000-000000000100",
            username: "freightcheck-production-management",
            display_name: "FreightCheck production management",
          },
        },
      ],
    },
  ],
};

describe("product catalog", () => {
  it.each([
    "products.json",
    "products.local.json",
  ])("keeps products without staff roles roleless in %s", (fileName) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    const freightclaims = catalog.products.find((product) => product.id === "freightclaims");
    if (!freightclaims) throw new Error("Expected FreightClaims product");
    expect(rolesForProduct(catalog, freightclaims)).toEqual([
      { key: "platform_support", display_name: "Platform Support" },
      { key: "platform_admin", display_name: "Platform Administrator" },
    ]);
    for (const product of catalog.products.filter(
      (candidate) => candidate.id !== "freightclaims",
    )) {
      expect(rolesForProduct(catalog, product)).toEqual([]);
    }
  });

  it.each([
    "products.json",
    "products.local.json",
  ])("enables native signup with the FreightClaims login policy in %s", (fileName) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    const freightclaims = catalog.products.find((product) => product.id === "freightclaims");

    expect(catalog.products.map((product) => product.id)).toEqual(["freightclaims"]);
    expect(freightclaims?.login_policy).toMatchObject({
      allow_self_registration: true,
      disable_login_with_email: false,
      disable_login_with_phone: false,
      ignore_unknown_usernames: true,
    });
  });

  it("enables imported-password verification only for hosted FreightClaims", () => {
    const catalog = catalogSchema.parse(
      JSON.parse(
        readFileSync(new URL("../deploy/products/products.json", import.meta.url), "utf8"),
      ),
    );
    const freightclaims = catalog.products.find((product) => product.id === "freightclaims");

    expect(freightclaims?.migration_service_account?.verify_imported_passwords).toBe(true);
  });

  it.each([
    "products.json",
    "products.local.json",
  ])("disables instance-organization user lookup for interactive products in %s", (fileName) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    const freightclaims = catalog.products.find((product) => product.id === "freightclaims");

    expect(freightclaims?.instance_org_user_lookup).toBe(false);
  });

  it("defaults products to no project roles", () => {
    const catalog = catalogSchema.parse(baseCatalog);
    const product = catalog.products[0];
    if (!product) throw new Error("Expected one product");
    expect(rolesForProduct(catalog, product)).toEqual([]);
    expect(product.login_policy).toMatchObject({
      allow_username_password: true,
      allow_self_registration: false,
      allow_password_reset: true,
    });
  });

  it("supports explicitly declared product-wide roles", () => {
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [
        {
          ...baseCatalog.products[0],
          roles: [{ key: "reviewer", display_name: "Reviewer" }],
        },
      ],
    });
    const product = catalog.products[0];
    if (!product) throw new Error("Expected one product");
    expect(rolesForProduct(catalog, product)).toEqual([
      { key: "reviewer", display_name: "Reviewer" },
    ]);
  });

  it("uses canonical staging and production secret names", () => {
    const catalog = catalogSchema.parse(baseCatalog);
    const product = catalog.products[0];
    const application = product?.applications[0];
    if (!product || !application) throw new Error("Expected one product application");
    expect(secretPrefix(product, application)).toBe("ZITADEL_FREIGHTCHECK_PRODUCTION");
  });

  it("allows a dedicated local migration account to request bounded password verification", () => {
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [
        {
          ...baseCatalog.products[0],
          migration_service_account: {
            id: "01900000-0000-7000-8000-000000000200",
            username: "freightcheck-local-migration",
            display_name: "FreightCheck local migration",
            verify_imported_passwords: true,
          },
        },
      ],
    });
    expect(catalog.products[0]?.migration_service_account?.verify_imported_passwords).toBe(true);
  });

  it("applies the allocated origin only to FreightClaims in the current local catalog", () => {
    const catalog = catalogSchema.parse(
      JSON.parse(
        readFileSync(new URL("../deploy/products/products.local.json", import.meta.url), "utf8"),
      ),
    );

    const configured = applyLocalCatalogProfile(catalog, {
      applicationBaseUrl: "http://localhost:26033",
      issuer: "http://localhost:26041",
    });
    const freightclaims = configured.products.find((product) => product.id === "freightclaims");

    expect(configured.issuer).toBe("http://localhost:26041");
    expect(configured.products.every((product) => product.auth_origin === configured.issuer)).toBe(
      true,
    );
    expect(freightclaims?.applications[0]?.base_url).toBe("http://localhost:26033");
    expect(freightclaims?.login_policy.default_redirect_uri).toBe("http://localhost:26033/");
  });

  it.each([
    "products.json",
    "products.local.json",
  ])("sends only FreightClaims invitees back to a FreightClaims application in %s", (fileName) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    const freightclaims = catalog.products.find((product) => product.id === "freightclaims");

    const redirect = freightclaims?.login_policy.default_redirect_uri;
    expect(redirect).toBeDefined();
    expect(
      freightclaims?.applications.map((application) => new URL(application.base_url).origin),
    ).toContain(new URL(String(redirect)).origin);
  });

  it("rejects a default redirect that is not under one of the product's applications", () => {
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            login_policy: { default_redirect_uri: "https://elsewhere.example.com/" },
          },
        ],
      }),
    ).toThrow(/default_redirect_uri is not under an application of freightcheck/u);
  });

  it("rejects an instance organization the product owns under another domain", () => {
    const result = catalogSchema.safeParse({
      ...baseCatalog,
      instance_organization: { name: "FreightCheck", domain: "operators.freightcheck.io" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("owns the instance organization");
  });

  it("rejects a local profile without a local application for the selected product", () => {
    expect(() =>
      applyLocalCatalogProfile(catalogSchema.parse(baseCatalog), {
        applicationBaseUrl: "http://localhost:26033",
        issuer: "http://localhost:26041",
      }),
    ).toThrow(/requires a local application for product freightclaims/u);
  });

  it("rejects a migration account that reuses an application management identity", () => {
    const management = baseCatalog.products[0]?.applications[0]?.management_service_account;
    if (!management) throw new Error("Expected one product application");
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            migration_service_account: management,
          },
        ],
      }),
    ).toThrow(/Duplicate product service-account/u);
  });

  it("rejects duplicate management service accounts within a product", () => {
    const application = baseCatalog.products[0]?.applications[0];
    if (!application) throw new Error("Expected one product application");
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            applications: [
              { ...application, environment: "staging" },
              { ...application, environment: "production" },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate management service-account/u);
  });

  it("requires local fixture assignments to use declared product-wide roles", () => {
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            local_fixture: {
              tenant: {
                id: "tenant",
                name: "Local tenant",
              },
              users: [
                {
                  key: "developer",
                  id: "user",
                  email: "developer@example.com",
                  display_name: "Local developer",
                  password: "Local-password-2026!",
                  roles: [],
                },
              ],
              service_accounts: [
                {
                  id: "machine",
                  username: "local-machine",
                  display_name: "Local machine",
                  roles: ["undeclared_role"],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/Unknown local service-account role/u);
  });

  it("defaults local human password changes to not required and accepts an explicit requirement", () => {
    const fixture = {
      tenant: { id: "tenant", name: "Local tenant" },
      users: [
        {
          key: "default-password",
          id: "user-default",
          email: "default@example.com",
          display_name: "Default password",
          password: "Local-password-2026!",
          roles: [],
        },
        {
          key: "required-password-change",
          id: "user-required",
          email: "required@example.com",
          display_name: "Required password change",
          password: "Local-password-2026!",
          password_change_required: true,
          roles: [],
        },
      ],
      service_accounts: [],
    };
    const catalog = catalogSchema.parse({
      ...baseCatalog,
      products: [{ ...baseCatalog.products[0], local_fixture: fixture }],
    });

    expect(catalog.products[0]?.local_fixture?.users).toMatchObject([
      { password_change_required: false },
      { password_change_required: true },
    ]);
  });

  it.each([
    ["key", { key: "developer-2", id: "user-1", email: "one@example.com" }],
    ["id", { key: "developer-1", id: "user-2", email: "one@example.com" }],
    ["email", { key: "developer-1", id: "user-1", email: "TWO@example.com" }],
  ] as const)("rejects a duplicate local user %s", (field, firstUser) => {
    expect(() =>
      catalogSchema.parse({
        ...baseCatalog,
        products: [
          {
            ...baseCatalog.products[0],
            local_fixture: {
              tenant: { id: "tenant", name: "Local tenant" },
              users: [
                {
                  ...firstUser,
                  display_name: "First user",
                  password: "Local-password-2026!",
                  roles: [],
                },
                {
                  key: "developer-2",
                  id: "user-2",
                  email: "two@example.com",
                  display_name: "Second user",
                  password: "Local-password-2026!",
                  roles: [],
                },
              ],
              service_accounts: [],
            },
          },
        ],
      }),
    ).toThrow(new RegExp(`Duplicate local user ${field}`, "u"));
  });
});

describe("FreightClaims-only instance", () => {
  it.each([
    "products.json",
    "products.local.json",
  ])("serves FreightClaims alone in %s", (fileName) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    expect(catalog.products.map((product) => product.id)).toEqual(["freightclaims"]);
  });

  it.each([
    ["products.json", "deploy/dokploy/compose.yml"],
    ["products.local.json", "docker-compose.yml"],
  ])("makes FreightClaims the only organization in %s, created by %s", (fileName, composePath) => {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(new URL(`../deploy/products/${fileName}`, import.meta.url), "utf8")),
    );
    const compose = readFileSync(new URL(`../${composePath}`, import.meta.url), "utf8");
    // The bootstrap brands the owner organization, so the first-instance organization is branded
    // from the deploy that creates it.
    expect(catalog.instance_organization).toEqual(catalog.products[0]?.owner_organization);
    expect(compose).toContain(
      `ZITADEL_FIRSTINSTANCE_ORG_NAME: ${catalog.instance_organization.name}\n`,
    );
    expect(catalog.issuer).toBe(catalog.products[0]?.auth_origin);
  });
});
