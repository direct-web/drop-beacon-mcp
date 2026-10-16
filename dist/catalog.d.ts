export declare const API_ORIGIN = "https://edc4me.com";
export declare const USER_AGENT = "DropBeaconMCP/0.3.0 (+https://edc4me.com)";
export declare const VERSION = "0.3.0";
export declare const TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            query: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            category: {
                type: string;
                enum: ["knife", "fidget", "flashlight", "pen", "wallet", "multi_tool", "patch", "other"];
            };
            brand: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
            };
            product?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            category: {
                type: string;
                enum: ["knife", "fidget", "flashlight", "pen", "wallet", "multi_tool", "patch", "other"];
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
            };
            query?: undefined;
            brand?: undefined;
            product?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            brand: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            query?: undefined;
            category?: undefined;
            limit?: undefined;
            product?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            product: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            query?: undefined;
            category?: undefined;
            brand?: undefined;
            limit?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
})[];
export declare class CatalogError extends Error {
}
export declare function publicProduct(value: unknown): {
    id: number | null;
    title: string | null;
    brand: string | null;
    category: string | null;
    price: number | null;
    currency: string | null;
    isAvailable: boolean | null;
    firstSeenAt: string | null;
    url: string | null;
    imageUrl: string | null;
};
export declare class Catalog {
    private fetcher;
    constructor(fetcher?: typeof fetch);
    private get;
    private brands;
    private products;
    call(name: string, args: unknown): Promise<{
        brands: {
            name: string | null;
            slug: string | null;
            category: string | null;
            availableProductCount: number | null;
            url: string | null;
        }[];
        source: string;
        checkedAt: string;
    } | {
        products: {
            id: number | null;
            title: string | null;
            brand: string | null;
            category: string | null;
            price: number | null;
            currency: string | null;
            isAvailable: boolean | null;
            firstSeenAt: string | null;
            url: string | null;
            imageUrl: string | null;
        }[];
        note: string;
        source: string;
        checkedAt: string;
    } | {
        matches: {
            id: number | null;
            title: string | null;
            brand: string | null;
            category: string | null;
            price: number | null;
            currency: string | null;
            isAvailable: boolean | null;
            firstSeenAt: string | null;
            url: string | null;
            imageUrl: string | null;
        }[];
        note: string;
        source: string;
        checkedAt: string;
    }>;
}
