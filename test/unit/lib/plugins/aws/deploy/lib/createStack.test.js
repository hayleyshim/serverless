'use strict';

const chai = require('chai');
const sandbox = require('sinon');
const path = require('path');
const AwsProvider = require('../../../../../../../lib/plugins/aws/provider');
const AwsDeploy = require('../../../../../../../lib/plugins/aws/deploy/index');
const Serverless = require('../../../../../../../lib/Serverless');
const { ServerlessError } = require('../../../../../../../lib/classes/Error');
const { getTmpDirPath } = require('../../../../../../utils/fs');

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));
const expect = require('chai').expect;

describe('createStack', () => {
  let awsDeploy;
  const tmpDirPath = getTmpDirPath();

  const serverlessYmlPath = path.join(tmpDirPath, 'serverless.yml');
  const serverlessYml = {
    service: 'first-service',
    provider: 'aws',
    functions: {
      first: {
        handler: 'sample.handler',
      },
    },
  };

  beforeEach(() => {
    const serverless = new Serverless();
    serverless.setProvider('aws', new AwsProvider(serverless, {}));
    serverless.utils.writeFileSync(serverlessYmlPath, serverlessYml);
    serverless.config.servicePath = tmpDirPath;
    const options = {
      stage: 'dev',
      region: 'us-east-1',
    };
    awsDeploy = new AwsDeploy(serverless, options);
    awsDeploy.serverless.service.service = `service-${new Date().getTime().toString()}`;
    awsDeploy.serverless.cli = new serverless.classes.CLI();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('#create()', () => {
    it('should include custom stack tags', () => {
      awsDeploy.serverless.service.provider.stackTags = { STAGE: 'overridden', tag1: 'value1' };

      const createStackStub = sandbox.stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return awsDeploy.create().then(() => {
        expect(createStackStub.args[0][2].Tags).to.deep.equal([
          { Key: 'STAGE', Value: 'overridden' },
          { Key: 'tag1', Value: 'value1' },
        ]);
      });
    });

    it('should override the default tags custom stack tags (case-insensitive)', () => {
      awsDeploy.serverless.service.provider.stackTags = { stage: 'overridden', tag1: 'value1' };

      const createStackStub = sandbox.stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return awsDeploy.create().then(() => {
        expect(createStackStub.args[0][2].Tags).to.deep.equal([
          { Key: 'stage', Value: 'overridden' },
          { Key: 'tag1', Value: 'value1' },
        ]);
      });
    });

    it('should add CAPABILITY_AUTO_EXPAND if a Transform directive is specified', () => {
      awsDeploy.serverless.service.provider.compiledCloudFormationTemplate = {
        Transform: 'MyMacro',
      };

      const createStackStub = sandbox.stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return awsDeploy.create().then(() => {
        expect(createStackStub.args[0][2].Capabilities).to.contain('CAPABILITY_AUTO_EXPAND');
      });
    });

    it('should use CloudFormation service role ARN if it is specified', () => {
      awsDeploy.serverless.service.provider.cfnRole = 'arn:aws:iam::123456789012:role/myrole';

      const createStackStub = sandbox.stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return awsDeploy.create().then(() => {
        expect(createStackStub.args[0][2].RoleARN).to.equal(
          'arn:aws:iam::123456789012:role/myrole'
        );
      });
    });

    it('should use use notificationArns if it is specified', () => {
      const mytopicArn = 'arn:aws:sns::123456789012:mytopic';
      awsDeploy.serverless.service.provider.notificationArns = [mytopicArn];

      const createStackStub = sandbox.stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return awsDeploy.create().then(() => {
        expect(createStackStub.args[0][2].NotificationARNs).to.deep.equal([mytopicArn]);
        awsDeploy.provider.request.restore();
        awsDeploy.monitorStack.restore();
      });
    });
  });

  describe('#createStack()', () => {
    it('should resolve if stack already created', () => {
      const createStub = sandbox.stub(awsDeploy, 'create').resolves();

      sandbox.stub(awsDeploy.provider, 'request').resolves();

      return awsDeploy.createStack().then(() => {
        expect(createStub.called).to.be.equal(false);
      });
    });

    it('should throw error if invalid stack name', async () => {
      sandbox.stub(awsDeploy, 'create').resolves();
      sandbox.stub(awsDeploy.provider, 'request').resolves();
      awsDeploy.serverless.service.service = 'service-name'.repeat(100);

      await expect(awsDeploy.createStack()).to.eventually.be.rejected.and.have.property(
        'code',
        'INVALID_STACK_NAME_ERROR'
      );
    });

    it('should set the createLater flag and resolve if deployment bucket is provided', async () => {
      awsDeploy.serverless.service.provider.deploymentBucket = 'serverless';
      sandbox.stub(awsDeploy.provider, 'request').rejects(new Error('does not exist'));

      await awsDeploy.createStack();
      expect(awsDeploy.createLater).to.be.true;
    });

    it('should throw error if describeStackResources fails for other reason than not found', async () => {
      const errorMock = new ServerlessError('Something went wrong');

      sandbox.stub(awsDeploy.provider, 'request').rejects(errorMock);
      sandbox.stub(awsDeploy, 'create').resolves();

      await expect(awsDeploy.createStack()).to.eventually.be.rejectedWith(errorMock);
    });

    it('should run promise chain in order', () => {
      const errorMock = {
        message: 'does not exist',
      };

      sandbox.stub(awsDeploy.provider, 'request').rejects(errorMock);

      const createStub = sandbox.stub(awsDeploy, 'create').resolves();

      return awsDeploy.createStack().then(() => {
        expect(createStub.calledOnce).to.be.true;
      });
    });

    it('should disable S3 Transfer Acceleration if missing Output', () => {
      const disableTransferAccelerationStub = sandbox
        .stub(awsDeploy.provider, 'disableTransferAccelerationForCurrentDeploy')
        .resolves();

      const describeStacksOutput = {
        Stacks: [
          {
            Outputs: [],
          },
        ],
      };
      sandbox.stub(awsDeploy.provider, 'request').resolves(describeStacksOutput);

      awsDeploy.provider.options['aws-s3-accelerate'] = true;

      return awsDeploy.createStack().then(() => {
        expect(disableTransferAccelerationStub.calledOnce).to.be.true;
      });
    });

    it('should not disable S3 Transfer Acceleration if custom bucket is used', () => {
      const disableTransferAccelerationStub = sandbox
        .stub(awsDeploy.provider, 'disableTransferAccelerationForCurrentDeploy')
        .resolves();

      const describeStacksOutput = {
        Stacks: [
          {
            Outputs: [],
          },
        ],
      };
      sandbox.stub(awsDeploy.provider, 'request').resolves(describeStacksOutput);

      awsDeploy.provider.options['aws-s3-accelerate'] = true;
      awsDeploy.serverless.service.provider.deploymentBucket = 'my-custom-bucket';

      return awsDeploy.createStack().then(() => {
        expect(disableTransferAccelerationStub.called).to.be.false;
      });
    });
  });
});
