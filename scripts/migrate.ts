import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';

async function run() {
  console.log('Iniciando migrações do banco de dados...');
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.migrator;
    const result = await migrator.up();
    console.log(`Migrações executadas com sucesso: ${result.length} migração(ões) aplicada(s).`);
  } finally {
    await orm.close(true);
  }
}

run().catch((err) => {
  console.error('Erro ao executar migrações:', err);
  process.exit(1);
});
