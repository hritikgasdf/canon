import { runRepoContract } from './repoContract';
import { createMemoryRepos } from '../src/domain/memoryRepos';

runRepoContract('memory', createMemoryRepos);
