import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Extension point for external Identity Provider (OIDC/Keycloak/Zitadel).
 * In accordance with Section 2 of the technical specification, authentication
 * is architected via this pluggable guard. Currently operates in permissive
 * mode while maintaining domain validation.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    // Extension point: in production with Keycloak/Zitadel, validate JWT/OAuth2 Bearer token:
    // const authHeader = request.headers['authorization'];
    // const provider = await this.idpPort.verifyToken(authHeader);
    // request.provider = provider;

    // Attach caller identity if present in header for tracing
    request.providerId = request.headers['x-provider-id'] ?? 'default-provider';

    return true;
  }
}
