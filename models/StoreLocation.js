/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// StoreLocation: synthetic store, branch, or warehouse dimension.
	const StoreLocation = sequelize.define('StoreLocation', {
		StoreLocationId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the store location.'
		},
		LocationCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic store or warehouse code.'
		},
		LocationName: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Synthetic store or warehouse display name.'
		}
	}, {
		tableName: 'StoreLocation',
		timestamps: false,
		freezeTableName: true
	});

	StoreLocation.associate = (models) => {
		StoreLocation.hasMany(models.SalesDocument, { foreignKey: 'StoreLocationId', as: 'SalesDocuments' });
	};

	return StoreLocation;
};
