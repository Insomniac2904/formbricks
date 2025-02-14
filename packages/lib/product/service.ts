import "server-only";

import { prisma } from "@formbricks/database";
import { ZId } from "@formbricks/types/environment";
import { DatabaseError, ValidationError } from "@formbricks/types/errors";
import type { TProduct, TProductUpdateInput } from "@formbricks/types/product";
import { ZProduct, ZProductUpdateInput } from "@formbricks/types/product";
import { Prisma } from "@prisma/client";
import { revalidateTag, unstable_cache } from "next/cache";
import { z } from "zod";
import { SERVICES_REVALIDATION_INTERVAL, ITEMS_PER_PAGE } from "../constants";
import { validateInputs } from "../utils/validate";
import { createEnvironment, getEnvironmentCacheTag, getEnvironmentsCacheTag } from "../environment/service";
import { ZOptionalNumber } from "@formbricks/types/common";

export const getProductsCacheTag = (teamId: string): string => `teams-${teamId}-products`;
export const getProductCacheTag = (environmentId: string): string => `environments-${environmentId}-product`;
const getProductCacheKey = (environmentId: string): string[] => [getProductCacheTag(environmentId)];

const selectProduct = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  teamId: true,
  brandColor: true,
  highlightBorderColor: true,
  recontactDays: true,
  formbricksSignature: true,
  placement: true,
  clickOutsideClose: true,
  darkOverlay: true,
  environments: true,
};

export const getProducts = async (teamId: string, page?: number): Promise<TProduct[]> =>
  unstable_cache(
    async () => {
      validateInputs([teamId, ZId], [page, ZOptionalNumber]);

      try {
        const products = await prisma.product.findMany({
          where: {
            teamId,
          },
          select: selectProduct,
          take: page ? ITEMS_PER_PAGE : undefined,
          skip: page ? ITEMS_PER_PAGE * (page - 1) : undefined,
        });

        return products;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new DatabaseError(error.message);
        }

        throw error;
      }
    },
    [`teams-${teamId}-products`],
    {
      tags: [getProductsCacheTag(teamId)],
      revalidate: SERVICES_REVALIDATION_INTERVAL,
    }
  )();

export const getProductByEnvironmentId = async (environmentId: string): Promise<TProduct | null> => {
  if (!environmentId) {
    throw new ValidationError("EnvironmentId is required");
  }
  let productPrisma;

  try {
    productPrisma = await prisma.product.findFirst({
      where: {
        environments: {
          some: {
            id: environmentId,
          },
        },
      },
      select: selectProduct,
    });

    return productPrisma;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error(error);
      throw new DatabaseError(error.message);
    }
    throw error;
  }
};

export const getProductByEnvironmentIdCached = (environmentId: string): Promise<TProduct | null> =>
  unstable_cache(
    async () => {
      return await getProductByEnvironmentId(environmentId);
    },
    getProductCacheKey(environmentId),
    {
      tags: getProductCacheKey(environmentId),
      revalidate: SERVICES_REVALIDATION_INTERVAL,
    }
  )();

export const updateProduct = async (
  productId: string,
  inputProduct: Partial<TProductUpdateInput>
): Promise<TProduct> => {
  validateInputs([productId, ZId], [inputProduct, ZProductUpdateInput.partial()]);
  const { environments, ...data } = inputProduct;
  let updatedProduct;
  try {
    updatedProduct = await prisma.product.update({
      where: {
        id: productId,
      },
      data: {
        ...data,
        environments: {
          connect: environments?.map((environment) => ({ id: environment.id })) ?? [],
        },
      },
      select: selectProduct,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }
  }

  try {
    const product = ZProduct.parse(updatedProduct);

    revalidateTag(getProductsCacheTag(product.teamId));
    product.environments.forEach((environment) => {
      // revalidate environment cache
      revalidateTag(getProductCacheTag(environment.id));
    });

    return product;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(JSON.stringify(error.errors, null, 2));
    }
    throw new ValidationError("Data validation of product failed");
  }
};

export const getProduct = async (productId: string): Promise<TProduct | null> => {
  let productPrisma;
  try {
    productPrisma = await prisma.product.findUnique({
      where: {
        id: productId,
      },
      select: selectProduct,
    });

    return productPrisma;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }
    throw error;
  }
};

export const deleteProduct = async (productId: string): Promise<TProduct> => {
  const product = await prisma.product.delete({
    where: {
      id: productId,
    },
    select: selectProduct,
  });

  if (product) {
    revalidateTag(getProductsCacheTag(product.teamId));
    revalidateTag(getEnvironmentsCacheTag(product.id));
    product.environments.forEach((environment) => {
      // revalidate product cache
      revalidateTag(getProductCacheTag(environment.id));
      revalidateTag(getEnvironmentCacheTag(environment.id));
    });
  }

  return product;
};

export const createProduct = async (
  teamId: string,
  productInput: Partial<TProductUpdateInput>
): Promise<TProduct> => {
  if (!productInput.name) {
    throw new ValidationError("Product Name is required");
  }

  const { environments, ...data } = productInput;

  let product = await prisma.product.create({
    data: {
      ...data,
      name: productInput.name,
      teamId,
    },
    select: selectProduct,
  });

  const devEnvironment = await createEnvironment(product.id, {
    type: "development",
  });

  const prodEnvironment = await createEnvironment(product.id, {
    type: "production",
  });

  product = await updateProduct(product.id, {
    environments: [devEnvironment, prodEnvironment],
  });

  return product;
};
