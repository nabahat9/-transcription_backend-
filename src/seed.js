import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { initDb, dbRun } from './db.js';

dotenv.config();

const seed = async () => {
  console.log('Initializing database tables...');
  
  try {
    // Ensure tables are created
    await initDb();
    
    console.log('Seeding database users...');

    // Clean existing users if any to avoid uniqueness constraint violations
    await dbRun('DELETE FROM users WHERE email IN (?, ?)', ['admin@dataset.com', 'worker@dataset.com']);

    // Admin Account
    const adminPass = await bcrypt.hash('adminpass123', 10);
    await dbRun(
      "INSERT INTO users (email, password_hash, role, name) VALUES ('admin@dataset.com', ?, 'admin', 'Super Admin')",
      [adminPass]
    );

    // Worker Account
    const workerPass = await bcrypt.hash('workerpass123', 10);
    await dbRun(
      "INSERT INTO users (email, password_hash, role, name) VALUES ('worker@dataset.com', ?, 'worker', 'Ahmed Darija')",
      [workerPass]
    );

    console.log('===================================================');
    console.log('  Database seeded successfully!');
    console.log('  ');
    console.log('  Admin User:');
    console.log('    Email: admin@dataset.com');
    console.log('    Password: adminpass123');
    console.log('  ');
    console.log('  Worker User:');
    console.log('    Email: worker@dataset.com');
    console.log('    Password: workerpass123');
    console.log('===================================================');

  } catch (error) {
    console.error('Failed to seed database:', error);
  } finally {
    // Note: Database handles are closed when the script exits
    process.exit(0);
  }
};

seed();
